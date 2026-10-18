/**
 * Reads GitHub Skill Sources for the update check (spec 11 §2 `skill.check`,
 * spec 16 B): the commit a branch points at, and the trees of skill folders at
 * that commit.
 *
 * Only public repositories are read, without a token:
 *
 * - the commit comes from `GET https://api.github.com/repos/{repo}/commits/{ref}`
 *   with `Accept: application/vnd.github.sha`, whose body is the commit id;
 * - the trees come from the gzip'd tar archive at
 *   `https://codeload.github.com/{repo}/tar.gz/{commit}`.
 *
 * Every request is bounded. Redirects are followed by hand, at most five, and
 * only to `https` GitHub hosts. Each request has a timeout. The archive is
 * read as a stream and never held whole: the compressed bytes, the
 * decompressed bytes, the bytes and entries kept per skill folder, and the
 * bytes kept for all folders together each have a cap.
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MAX_SKILL_FILES } from "@hercule/contract";
import {
  convertToSkillFileMode,
  escapeControlCharacters,
  MAX_SKILL_BYTES,
  padToTarBlock,
  parseUstarHeader,
  TAR_BLOCK_SIZE,
  type SkillArchiveEntry,
} from "@hercule/protocol";
import { formatMebibytes } from "./content";

/** A GitHub Skill Source could not be read; `message` is shown to the user as the Skill's checkError. */
export class SkillSourceUnreadable extends Data.TaggedError("SkillSourceUnreadable")<{
  readonly message: string;
}> {}

/**
 * One skill folder read from a downloaded tree.
 *
 * - `Tree` holds the folder's entries, with paths relative to the folder.
 *   Every kind of entry but a directory is kept, so the content rules can
 *   refuse a symbolic link. Modes are normalized to `0o644` or `0o755`,
 *   because `git archive` writes the modes a umask leaves, such as `664`.
 * - `Refused` means the folder cannot become a revision at that commit:
 *   there is no such folder, it holds more than 1,000 entries, or it is over
 *   the 10 MiB cap. `reason` is a message for the user.
 */
export type DownloadedSkillTree =
  | { readonly _tag: "Tree"; readonly entries: ReadonlyArray<SkillArchiveEntry> }
  | { readonly _tag: "Refused"; readonly reason: string };

/** The `fetch` this module calls. Production passes `globalThis.fetch`; tests pass a fake. */
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const USER_AGENT = "hercule";
const ALLOWED_HOSTS = new Set(["github.com", "api.github.com", "codeload.github.com"]);
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const COMMIT_LOOKUP_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024;
/**
 * The most bytes one download keeps for all its folders together: content,
 * headers and paths. Each folder keeps at most 10 MiB, but a check of many
 * skills in one repository could otherwise keep many times that.
 */
const MAX_KEPT_BYTES = 64 * 1024 * 1024;
/** The largest pax or GNU long-name header read; real ones hold a path or two. */
const MAX_EXTENSION_HEADER_BYTES = 1024 * 1024;
const COMMIT_ID = /^[0-9a-f]{40}$/;

/**
 * Builds the GitHub Skill Sources service on `fetch`. `fetch` is the only
 * thing a test replaces.
 */
export const makeGithubSkillSources = (fetch: Fetch) => ({
  /**
   * Returns the 40-hex commit the branch points at, or the default branch's
   * commit when `branch` is null. Fails with `SkillSourceUnreadable` when
   * GitHub cannot be reached, refuses the request, or returns no commit id.
   */
  readUpstreamCommit: (
    repo: string,
    branch: string | null,
  ): Effect.Effect<string, SkillSourceUnreadable> =>
    runWithTimeout(
      COMMIT_LOOKUP_TIMEOUT_MS,
      `GitHub took longer than 30 seconds to return the latest commit of \`${repo}\`, so the check stopped. The next check tries again.`,
      async (signal) => {
        const ref = branch === null ? "HEAD" : encodePathSegments(branch);
        const response = await fetchFollowingRedirects(
          fetch,
          `https://api.github.com/repos/${encodePathSegments(repo)}/commits/${ref}`,
          { "User-Agent": USER_AGENT, Accept: "application/vnd.github.sha" },
          signal,
        );
        if (!response.ok) {
          throw describeFailedResponse(
            response,
            branch === null
              ? `GitHub has no repository \`${repo}\`, or it is private. Only public repositories can be checked; check the repository in the Skill Source.`
              : `GitHub has no branch \`${branch}\` in \`${repo}\`, or the repository is private. Only public repositories can be checked; check the repository and branch in the Skill Source.`,
          );
        }
        const body = (await readBodyText(response, signal)).trim();
        if (!COMMIT_ID.test(body)) {
          throw new SkillSourceUnreadable({
            message: `GitHub returned something other than a commit id for \`${repo}\`. The next check tries again.`,
          });
        }
        return body;
      },
    ),

  /**
   * Downloads the repository at `commit` once and returns the tree of each
   * folder in `paths`, keyed by the path as given. A path is a folder inside
   * the repository; `""` or `"."` is its root, and a trailing `/` is ignored.
   *
   * A folder that is missing or over a cap is a `Refused` tree, not a
   * failure. Fails with `SkillSourceUnreadable` when the download itself
   * fails: GitHub cannot be reached or refuses it, it takes too long, it is
   * too large, the folders hold more than 64 MiB together, or it is not a
   * gzip'd tar archive.
   */
  downloadSkillTrees: (
    repo: string,
    commit: string,
    paths: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyMap<string, DownloadedSkillTree>, SkillSourceUnreadable> =>
    runWithTimeout(
      DOWNLOAD_TIMEOUT_MS,
      `Downloading \`${repo}\` from GitHub took longer than 2 minutes, so the check stopped. The next check tries again.`,
      async (signal) => {
        const response = await fetchFollowingRedirects(
          fetch,
          `https://codeload.github.com/${encodePathSegments(repo)}/tar.gz/${encodeURIComponent(commit)}`,
          { "User-Agent": USER_AGENT },
          signal,
        );
        if (!response.ok || response.body === null) {
          throw describeFailedResponse(
            response,
            `GitHub has no commit ${commit} in \`${repo}\`, or the repository is private. Only public repositories can be checked; check the repository in the Skill Source.`,
          );
        }
        const folders = paths.map((path) => ({ path, segments: splitFolderPath(path) }));
        const reading = { failure: undefined as SkillSourceUnreadable | undefined };
        const compressed = limitCompressedBytes(response.body, repo, reading);
        try {
          const states = await readSkillFolders(
            compressed.pipeThrough(new DecompressionStream("gzip")),
            repo,
            folders.map((folder) => folder.segments),
          );
          return new Map(
            folders.map((folder, index) => [
              folder.path,
              decideSkillTree(states[index]!, repo, commit, folder.segments),
            ]),
          );
        } catch (error) {
          // The order matters: a failure of the compressed stream also makes
          // the decompressor fail, and the cause the user needs is the first.
          if (reading.failure !== undefined) throw reading.failure;
          if (signal.aborted || error instanceof SkillSourceUnreadable) throw error;
          throw new SkillSourceUnreadable({
            message: `The download of \`${repo}\` from GitHub is not a valid gzip file. The next check tries again.`,
          });
        }
      },
    ),
});

export class GithubSkillSources extends Context.Service<
  GithubSkillSources,
  ReturnType<typeof makeGithubSkillSources>
>()("hercule/controller/skills/GithubSkillSources") {}

/** The GitHub Skill Sources service on the global `fetch`. */
export const GithubSkillSourcesLayer: Layer.Layer<GithubSkillSources> = Layer.sync(
  GithubSkillSources,
)(() => makeGithubSkillSources((url, init) => globalThis.fetch(url, init)));

/**
 * Runs one request with a timeout. The request's signal aborts when the
 * timeout passes or the Effect is interrupted, so the fetch and its body
 * really stop. Fails with `timeoutMessage` when the timeout passed.
 */
const runWithTimeout = <A>(
  timeoutMs: number,
  timeoutMessage: string,
  run: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, SkillSourceUnreadable> =>
  Effect.tryPromise({
    try: async (interruption) => {
      const timeout = AbortSignal.timeout(timeoutMs);
      try {
        return await run(AbortSignal.any([interruption, timeout]));
      } catch (error) {
        if (timeout.aborted) throw new SkillSourceUnreadable({ message: timeoutMessage });
        throw error;
      }
    },
    catch: (error) =>
      error instanceof SkillSourceUnreadable
        ? error
        : new SkillSourceUnreadable({
            message: `Reading GitHub failed: ${describeError(error)}. The next check tries again.`,
          }),
  });

/** URL-encodes each `/`-separated segment of a repository or branch name, keeping the `/`s. */
const encodePathSegments = (path: string): string =>
  path.split("/").map(encodeURIComponent).join("/");

/**
 * Fetches `url` and follows redirects by hand, at most five, and only to
 * `https` URLs on a GitHub host. Returns the first response that is not a
 * redirect. Fails with `SkillSourceUnreadable` when GitHub cannot be reached
 * or a redirect breaks those rules; an abort is rethrown as it is, so the
 * caller can tell a timeout.
 */
const fetchFollowingRedirects = async (
  fetch: Fetch,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Response> => {
  let current = url;
  for (let redirects = 0; ; redirects++) {
    let response: Response;
    try {
      response = await fetch(current, { headers, redirect: "manual", signal });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new SkillSourceUnreadable({
        message: `Could not reach GitHub: ${describeError(error)}. The next check tries again.`,
      });
    }
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (location === null || redirects === MAX_REDIRECTS) {
      throw new SkillSourceUnreadable({
        message: `GitHub redirected the request more than ${MAX_REDIRECTS} times, or without saying where to, so the check stopped. The next check tries again.`,
      });
    }
    const next = URL.parse(location, current);
    if (
      next === null ||
      next.protocol !== "https:" ||
      next.port !== "" ||
      !ALLOWED_HOSTS.has(next.hostname)
    ) {
      throw new SkillSourceUnreadable({
        message: `GitHub redirected the request to ${next === null ? "an invalid address" : next.host}, which is not a GitHub address, so the check stopped.`,
      });
    }
    current = next.href;
  }
};

/**
 * Returns the error for a response GitHub refused: `notFoundMessage` for a
 * 404, a message about the rate limit when the limit for requests without a
 * token ran out, and a message naming the status for anything else.
 */
const describeFailedResponse = (
  response: Response,
  notFoundMessage: string,
): SkillSourceUnreadable => {
  void response.body?.cancel();
  if (response.status === 404) return new SkillSourceUnreadable({ message: notFoundMessage });
  if (
    (response.status === 403 || response.status === 429) &&
    response.headers.get("x-ratelimit-remaining") === "0"
  ) {
    const resetSeconds = Number(response.headers.get("x-ratelimit-reset"));
    const resetAt =
      response.headers.has("x-ratelimit-reset") && Number.isFinite(resetSeconds)
        ? ` It resets at ${new Date(resetSeconds * 1000).toISOString().slice(11, 16)} UTC.`
        : "";
    return new SkillSourceUnreadable({
      message: `GitHub's limit on requests without a sign-in ran out for this controller's address.${resetAt} The next check tries again.`,
    });
  }
  return new SkillSourceUnreadable({
    message: `GitHub returned HTTP ${response.status}. The next check tries again.`,
  });
};

/** Reads a response body as text, failing with `SkillSourceUnreadable` when the connection breaks. */
const readBodyText = async (response: Response, signal: AbortSignal): Promise<string> => {
  try {
    return await response.text();
  } catch (error) {
    if (signal.aborted) throw error;
    throw new SkillSourceUnreadable({
      message: `The connection to GitHub broke: ${describeError(error)}. The next check tries again.`,
    });
  }
};

/** Returns an error's message for a user, or the value as text when it is not an `Error`. */
const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Wraps the compressed body in a stream that stops past 64 MiB and records
 * why it stopped in `reading.failure`, for a cap passed and a broken
 * connection both. The record matters because the decompressor that reads
 * this stream fails with an error of its own, which would hide the cause.
 */
const limitCompressedBytes = (
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
  repo: string,
  reading: { failure: SkillSourceUnreadable | undefined },
): ReadableStream<Uint8Array<ArrayBuffer>> => {
  const reader = body.getReader();
  let received = 0;
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      const result = await reader.read().catch((error: unknown) => {
        reading.failure = new SkillSourceUnreadable({
          message: `The connection to GitHub broke while downloading \`${repo}\`: ${describeError(error)}. The next check tries again.`,
        });
        throw reading.failure;
      });
      if (result.done) {
        controller.close();
        return;
      }
      received += result.value.byteLength;
      if (received > MAX_COMPRESSED_BYTES) {
        reading.failure = new SkillSourceUnreadable({
          message: `The download of \`${repo}\` from GitHub is over 64 MiB, more than a check reads. Skills in a repository this large cannot be checked for updates.`,
        });
        await reader.cancel();
        throw reading.failure;
      }
      controller.enqueue(result.value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
};

/** Splits a Skill Source path into its folder names: `""`, `"."` and `"/"` are the root, an empty list. */
const splitFolderPath = (path: string): ReadonlyArray<string> =>
  path.split("/").filter((segment) => segment !== "" && segment !== ".");

/** What reading the archive found for one requested folder. */
interface SkillFolderState {
  /** Whether any entry lies inside the folder. */
  found: boolean;
  /** The kept entries; emptied once the folder is over a cap. */
  entries: Array<SkillArchiveEntry>;
  /**
   * The length of the skill archive the folder's entries would build, counted
   * past the cap too. Every entry but a directory counts, links included, so
   * a folder of links cannot pass the cap for free.
   */
  archiveBytes: number;
  /** How many entries other than directories the folder holds, counted past the cap too. */
  entryCount: number;
  /** The first path inside the folder that is not UTF-8 text. */
  pathNotUtf8: string | undefined;
}

/** Returns the tree to report for one folder, from what reading the archive found for it. */
const decideSkillTree = (
  state: SkillFolderState,
  repo: string,
  commit: string,
  segments: ReadonlyArray<string>,
): DownloadedSkillTree => {
  const folder =
    segments.length === 0
      ? `The root of \`${repo}\``
      : `The folder \`${escapeControlCharacters(segments.join("/"))}\``;
  if (!state.found) {
    return {
      _tag: "Refused",
      reason:
        segments.length === 0
          ? `\`${repo}\` is empty at commit ${commit.slice(0, 7)}. Check the repository in the Skill Source.`
          : `\`${repo}\` has no folder \`${escapeControlCharacters(segments.join("/"))}\` at commit ${commit.slice(0, 7)}. Check the path in the Skill Source.`,
    };
  }
  if (state.entryCount > MAX_SKILL_FILES) {
    return {
      _tag: "Refused",
      reason: `${folder} has ${state.entryCount.toLocaleString("en-US")} files at commit ${commit.slice(0, 7)}. A skill holds at most ${MAX_SKILL_FILES.toLocaleString("en-US")}; remove the files it does not need.`,
    };
  }
  if (state.archiveBytes > MAX_SKILL_BYTES) {
    return {
      _tag: "Refused",
      reason: `${folder} is ${formatMebibytes(state.archiveBytes)} as a tar archive at commit ${commit.slice(0, 7)}. A skill's archive may be at most 10 MiB.`,
    };
  }
  if (state.pathNotUtf8 !== undefined) {
    return {
      _tag: "Refused",
      reason: `${folder} has a file whose path is not UTF-8 text at commit ${commit.slice(0, 7)}: \`${escapeControlCharacters(state.pathNotUtf8)}\`. A skill's paths must be UTF-8 text.`,
    };
  }
  return { _tag: "Tree", entries: state.entries };
};

const END_BLOCKS_BYTES = 2 * TAR_BLOCK_SIZE;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lossyUtf8 = new TextDecoder("utf-8", { ignoreBOM: true });

/** A path read from a tar header: its text, and whether its bytes were valid UTF-8. */
interface EntryPath {
  readonly text: string;
  readonly isUtf8: boolean;
}

/** Decodes path bytes as UTF-8, replacing invalid bytes, and records whether there were any. */
const decodeEntryPath = (bytes: Uint8Array): EntryPath => {
  try {
    return { text: utf8.decode(bytes), isUtf8: true };
  } catch {
    return { text: lossyUtf8.decode(bytes), isUtf8: false };
  }
};

/**
 * Reads the gzip-decompressed archive and returns, for each folder in
 * `folders` (in order), what lies inside it. Reads the stream once, keeps only
 * the content of files inside a requested folder that is under its caps, and
 * cancels the stream at the archive's end marker.
 *
 * The archive is the one codeload writes: one top-level folder named for the
 * repository and commit, a pax global header, and pax `x` headers for long
 * paths. GNU long-name headers are read too. The top-level folder is dropped
 * from every path.
 *
 * Fails with `SkillSourceUnreadable` when the archive is damaged, cut off,
 * decompresses to more than 512 MiB, or the folders keep more than 64 MiB
 * together; the decompressor's own error passes through for a file that is
 * not gzip.
 */
const readSkillFolders = async (
  stream: ReadableStream<Uint8Array>,
  repo: string,
  folders: ReadonlyArray<ReadonlyArray<string>>,
): Promise<ReadonlyArray<SkillFolderState>> => {
  const damaged = (what: string) =>
    new SkillSourceUnreadable({
      message: `The download of \`${repo}\` from GitHub is damaged: ${what}. The next check tries again.`,
    });
  const bytes = readBytesFrom(stream, () => damaged("it ends in the middle of an entry"));
  const states: Array<SkillFolderState> = folders.map(() => ({
    found: false,
    entries: [],
    archiveBytes: END_BLOCKS_BYTES,
    entryCount: 0,
    pathNotUtf8: undefined,
  }));
  let keptBytes = 0;
  let extendedPath: EntryPath | undefined;
  let extendedSize: number | undefined;
  try {
    for (;;) {
      const block = await bytes.read(TAR_BLOCK_SIZE, { atEntryStart: true });
      if (block === null || block.every((byte) => byte === 0)) break;
      const header = parseUstarHeader(block);
      if (header === "notANumber")
        throw damaged("an entry has a size or mode that is not a number");
      if (typeof header === "string") throw damaged("an entry has no valid tar header");
      const { typeflag, kind, mode, size: headerSize } = header;

      if (typeflag === "x" || typeflag === "L") {
        if (headerSize > MAX_EXTENSION_HEADER_BYTES) {
          throw damaged("an extension header is larger than 1 MiB");
        }
        const data = (await bytes.read(padToTarBlock(headerSize)))!.subarray(0, headerSize);
        if (typeflag === "L") {
          const end = data.indexOf(0);
          extendedPath = decodeEntryPath(end === -1 ? data : data.subarray(0, end));
        } else {
          const records = parsePaxRecords(data);
          if (records === null) throw damaged("a pax header cannot be read");
          if (records.path !== undefined) extendedPath = records.path;
          if (records.size !== undefined) extendedSize = records.size;
        }
        continue;
      }
      if (typeflag === "g" || typeflag === "K") {
        await bytes.skip(padToTarBlock(headerSize));
        continue;
      }

      const path = extendedPath ?? decodeEntryPath(header.path);
      const size = extendedSize ?? headerSize;
      extendedPath = undefined;
      extendedSize = undefined;
      const insideTop = splitEntryPath(path.text).slice(1);

      // The folders this entry lies in, each with the entry's path relative to it.
      const matches: Array<{ readonly state: SkillFolderState; readonly relative: string }> = [];
      folders.forEach((folder, index) => {
        if (insideTop.length <= folder.length) return;
        if (!folder.every((segment, at) => insideTop[at] === segment)) return;
        matches.push({ state: states[index]!, relative: insideTop.slice(folder.length).join("/") });
      });

      // An entry is kept only by a folder still under its caps: 10 MiB and
      // 1,000 entries. A file's content is read only when some folder keeps
      // it, and what all folders keep together is capped below.
      const keepers: typeof matches = [];
      for (const match of matches) {
        const state = match.state;
        state.found = true;
        if (kind === "directory") continue;
        state.entryCount += 1;
        state.archiveBytes += TAR_BLOCK_SIZE + padToTarBlock(size);
        if (state.archiveBytes > MAX_SKILL_BYTES || state.entryCount > MAX_SKILL_FILES) {
          state.entries = [];
          continue;
        }
        if (!path.isUtf8) {
          state.pathNotUtf8 ??= match.relative;
          continue;
        }
        keepers.push(match);
      }

      // Only a file's content is kept; whatever data another kind of entry has is skipped.
      let content: Uint8Array = new Uint8Array(0);
      if (kind === "file" && keepers.length > 0) {
        content = (await bytes.read(size))!;
        await bytes.skip(padToTarBlock(size) - size);
      } else {
        await bytes.skip(padToTarBlock(size));
      }
      keptBytes += content.byteLength;
      for (const { relative } of keepers) keptBytes += TAR_BLOCK_SIZE + relative.length;
      if (keptBytes > MAX_KEPT_BYTES) {
        throw new SkillSourceUnreadable({
          message: `The skill folders this check reads from \`${repo}\` hold more than 64 MiB together, more than one check keeps. Check fewer skills from this repository, or make them smaller.`,
        });
      }
      const normalizedMode = convertToSkillFileMode(mode) === "755" ? 0o755 : 0o644;
      for (const { state, relative } of keepers) {
        state.entries.push({ path: relative, kind, mode: normalizedMode, content });
      }
    }
  } finally {
    await bytes.cancel();
  }
  return states;
};

/**
 * Returns a reader of exact byte counts over `stream`, counting every byte it
 * reads against the 512 MiB decompressed cap.
 *
 * `read(length)` returns a new array of `length` bytes. With `atEntryStart`
 * it returns null when the stream ended exactly there; otherwise a stream
 * that ends early fails with `cutOff()`. `skip(length)` reads past `length`
 * bytes without keeping them.
 */
const readBytesFrom = (stream: ReadableStream<Uint8Array>, cutOff: () => SkillSourceUnreadable) => {
  const reader = stream.getReader();
  let chunk: Uint8Array = new Uint8Array(0);
  let position = 0;
  let total = 0;

  /** Reads the next chunk; returns false at the end of the stream. */
  const readNextChunk = async (): Promise<boolean> => {
    const result = await reader.read();
    if (result.done) return false;
    total += result.value.byteLength;
    if (total > MAX_DECOMPRESSED_BYTES) {
      throw new SkillSourceUnreadable({
        message:
          "The download from GitHub decompresses to more than 512 MiB, more than a check reads. Skills in a repository this large cannot be checked for updates.",
      });
    }
    chunk = result.value;
    position = 0;
    return true;
  };

  /** Moves past `length` bytes, handing each piece to `take`. Returns how many bytes it moved past, fewer when the stream ended first. */
  const consume = async (
    length: number,
    take: (piece: Uint8Array, offset: number) => void,
  ): Promise<number> => {
    let done = 0;
    while (done < length) {
      if (position === chunk.length && !(await readNextChunk())) break;
      const count = Math.min(length - done, chunk.length - position);
      take(chunk.subarray(position, position + count), done);
      position += count;
      done += count;
    }
    return done;
  };

  return {
    read: async (
      length: number,
      options: { readonly atEntryStart: boolean } = { atEntryStart: false },
    ): Promise<Uint8Array | null> => {
      const bytes = new Uint8Array(length);
      const done = await consume(length, (piece, offset) => bytes.set(piece, offset));
      if (done === length) return bytes;
      if (done === 0 && options.atEntryStart) return null;
      throw cutOff();
    },
    skip: async (length: number): Promise<void> => {
      if ((await consume(length, () => {})) !== length) throw cutOff();
    },
    cancel: () => reader.cancel().catch(() => {}),
  };
};

/**
 * Parses the records of a pax header (`<length> <key>=<value>\n`, the length
 * in bytes and counting the whole record) and returns the `path` and `size`
 * it sets. Returns null when the records are malformed.
 */
const parsePaxRecords = (data: Uint8Array): { path?: EntryPath; size?: number } | null => {
  const records: { path?: EntryPath; size?: number } = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) return null;
    const length = Number(String.fromCharCode(...data.subarray(offset, space)));
    if (
      !Number.isInteger(length) ||
      length <= space - offset + 1 ||
      offset + length > data.length
    ) {
      return null;
    }
    const record = data.subarray(space + 1, offset + length - 1);
    const equals = record.indexOf(0x3d);
    if (equals === -1) return null;
    const key = String.fromCharCode(...record.subarray(0, equals));
    const value = record.subarray(equals + 1);
    if (key === "path") records.path = decodeEntryPath(value);
    if (key === "size") {
      const size = Number(String.fromCharCode(...value));
      if (!Number.isSafeInteger(size) || size < 0) return null;
      records.size = size;
    }
    offset += length;
  }
  return records;
};

/** Splits an archive path into its segments, dropping the trailing `/` of a directory. */
const splitEntryPath = (path: string): Array<string> => {
  const segments = path.split("/");
  if (segments.at(-1) === "") segments.pop();
  return segments;
};
