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
 * Requests go through Effect's `HttpClient`. Every request is bounded.
 * Redirects are followed by hand, at most five, and only to `https` GitHub
 * hosts. Each request has a timeout. The archive is read as a stream and never
 * held whole: the compressed bytes, the decompressed bytes, the bytes and
 * entries kept per skill folder, and the bytes kept for all folders together
 * each have a cap.
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
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

/** The client every request goes through: one whose requests are aborted when their scope closes. */
type ScopedHttpClient = HttpClient.HttpClient.With<HttpClientError.HttpClientError, Scope.Scope>;

const USER_AGENT = "hercule";
const ALLOWED_HOSTS = new Set(["github.com", "api.github.com", "codeload.github.com"]);
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const COMMIT_LOOKUP_TIMEOUT = Duration.seconds(30);
const DOWNLOAD_TIMEOUT = Duration.minutes(2);
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

const make = Effect.gen(function* () {
  // Each method runs in a scope of its own, and closing the scope aborts every
  // request the method sent. That stops the body of a redirect or a refusal
  // nobody reads, and a download that a timeout or an interruption ended.
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);

  return {
    /**
     * Returns the 40-hex commit the branch points at, or the default branch's
     * commit when `branch` is null. Fails with `SkillSourceUnreadable` when
     * GitHub cannot be reached, refuses the request, takes longer than 30
     * seconds, or returns no commit id.
     */
    readUpstreamCommit: (
      repo: string,
      branch: string | null,
    ): Effect.Effect<string, SkillSourceUnreadable> =>
      Effect.gen(function* () {
        const ref = branch === null ? "HEAD" : encodePathSegments(branch);
        const response = yield* sendFollowingRedirects(
          client,
          `https://api.github.com/repos/${encodePathSegments(repo)}/commits/${ref}`,
          { "user-agent": USER_AGENT, accept: "application/vnd.github.sha" },
        );
        if (!isSuccess(response)) {
          return yield* describeFailedResponse(
            response,
            branch === null
              ? `GitHub has no repository \`${repo}\`, or it is private. Only public repositories can be checked; check the repository in the Skill Source.`
              : `GitHub has no branch \`${branch}\` in \`${repo}\`, or the repository is private. Only public repositories can be checked; check the repository and branch in the Skill Source.`,
          );
        }
        const text = yield* response.text.pipe(
          Effect.mapError(
            (error) =>
              new SkillSourceUnreadable({
                message: `The connection to GitHub broke: ${describeHttpError(error)}. The next check tries again.`,
              }),
          ),
        );
        const body = text.trim();
        if (!COMMIT_ID.test(body)) {
          return yield* new SkillSourceUnreadable({
            message: `GitHub returned something other than a commit id for \`${repo}\`. The next check tries again.`,
          });
        }
        return body;
      }).pipe(
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: COMMIT_LOOKUP_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new SkillSourceUnreadable({
                message: `GitHub took longer than 30 seconds to return the latest commit of \`${repo}\`, so the check stopped. The next check tries again.`,
              }),
            ),
        }),
      ),

    /**
     * Downloads the repository at `commit` once and returns the tree of each
     * folder in `paths`, keyed by the path as given. A path is a folder inside
     * the repository; `""` or `"."` is its root, and a trailing `/` is ignored.
     *
     * A folder that is missing or over a cap is a `Refused` tree, not a
     * failure. Fails with `SkillSourceUnreadable` when the download itself
     * fails: GitHub cannot be reached or refuses it, it takes longer than 2
     * minutes, it is too large, the folders hold more than 64 MiB together,
     * or it is not a gzip'd tar archive.
     */
    downloadSkillTrees: (
      repo: string,
      commit: string,
      paths: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyMap<string, DownloadedSkillTree>, SkillSourceUnreadable> =>
      Effect.gen(function* () {
        const response = yield* sendFollowingRedirects(
          client,
          `https://codeload.github.com/${encodePathSegments(repo)}/tar.gz/${encodeURIComponent(commit)}`,
          { "user-agent": USER_AGENT },
        );
        if (!isSuccess(response)) {
          return yield* describeFailedResponse(
            response,
            `GitHub has no commit ${commit} in \`${repo}\`, or the repository is private. Only public repositories can be checked; check the repository in the Skill Source.`,
          );
        }
        const folders = paths.map((path) => ({ path, segments: splitFolderPath(path) }));
        const compressed = Stream.toReadableStream(limitCompressedBytes(response.stream, repo));
        const states = yield* Effect.tryPromise({
          try: () =>
            readSkillFolders(
              compressed.pipeThrough(new DecompressionStream("gzip")),
              repo,
              folders.map((folder) => folder.segments),
            ),
          // The decompressor passes on the error of the compressed stream as
          // it is, so a broken connection or the compressed cap arrives here
          // as `SkillSourceUnreadable`. Any other error is the decompressor's.
          catch: (error) =>
            error instanceof SkillSourceUnreadable
              ? error
              : new SkillSourceUnreadable({
                  message: `The download of \`${repo}\` from GitHub is not a valid gzip file. The next check tries again.`,
                }),
        });
        return new Map(
          folders.map((folder, index) => [
            folder.path,
            decideSkillTree(states[index]!, repo, commit, folder.segments),
          ]),
        );
      }).pipe(
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: DOWNLOAD_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new SkillSourceUnreadable({
                message: `Downloading \`${repo}\` from GitHub took longer than 2 minutes, so the check stopped. The next check tries again.`,
              }),
            ),
        }),
      ),
  };
});

export class GithubSkillSources extends Context.Service<
  GithubSkillSources,
  Effect.Success<typeof make>
>()("hercule/controller/skills/GithubSkillSources") {}

/** The GitHub Skill Sources service, sending its requests through the `HttpClient` it is given. */
export const GithubSkillSourcesLayer: Layer.Layer<
  GithubSkillSources,
  never,
  HttpClient.HttpClient
> = Layer.effect(GithubSkillSources)(make);

/** URL-encodes each `/`-separated segment of a repository or branch name, keeping the `/`s. */
const encodePathSegments = (path: string): string =>
  path.split("/").map(encodeURIComponent).join("/");

/** Checks whether a response has a 2xx status. */
const isSuccess = (response: HttpClientResponse.HttpClientResponse): boolean =>
  response.status >= 200 && response.status < 300;

/**
 * Sends a GET to `url` and follows redirects by hand, at most five, and only
 * to `https` URLs on a GitHub host with no port and no user name. Returns the
 * first response that is not a redirect. Fails with `SkillSourceUnreadable`
 * when GitHub cannot be reached or a redirect breaks those rules.
 */
const sendFollowingRedirects = (
  client: ScopedHttpClient,
  url: string,
  headers: Record<string, string>,
): Effect.Effect<HttpClientResponse.HttpClientResponse, SkillSourceUnreadable, Scope.Scope> =>
  Effect.gen(function* () {
    let current = url;
    for (let redirects = 0; ; redirects++) {
      const response = yield* client.get(current, { headers }).pipe(
        // `fetch` follows redirects on its own unless told not to; the rules
        // above can only be applied to a redirect that comes back unfollowed.
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.mapError(
          (error) =>
            new SkillSourceUnreadable({
              message: `Could not reach GitHub: ${describeHttpError(error)}. The next check tries again.`,
            }),
        ),
      );
      if (!REDIRECT_STATUSES.has(response.status)) return response;
      const location = response.headers["location"];
      if (location === undefined || redirects === MAX_REDIRECTS) {
        return yield* new SkillSourceUnreadable({
          message: `GitHub redirected the request more than ${MAX_REDIRECTS} times, or without saying where to, so the check stopped. The next check tries again.`,
        });
      }
      const next = URL.parse(location, current);
      if (
        next === null ||
        next.protocol !== "https:" ||
        next.port !== "" ||
        next.username !== "" ||
        next.password !== "" ||
        !ALLOWED_HOSTS.has(next.hostname)
      ) {
        return yield* new SkillSourceUnreadable({
          message: `GitHub redirected the request to ${next === null ? "an invalid address" : next.host}, which is not a GitHub address, so the check stopped.`,
        });
      }
      current = next.href;
    }
  });

/**
 * Returns the error for a response GitHub refused: `notFoundMessage` for a
 * 404, a message about the rate limit when the limit for requests without a
 * token ran out, and a message naming the status for anything else.
 */
const describeFailedResponse = (
  response: HttpClientResponse.HttpClientResponse,
  notFoundMessage: string,
): SkillSourceUnreadable => {
  if (response.status === 404) return new SkillSourceUnreadable({ message: notFoundMessage });
  if (
    (response.status === 403 || response.status === 429) &&
    response.headers["x-ratelimit-remaining"] === "0"
  ) {
    const reset = response.headers["x-ratelimit-reset"];
    const resetSeconds = Number(reset);
    const resetAt =
      reset !== undefined && Number.isFinite(resetSeconds)
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

/**
 * Returns the message of what made a request fail, for a user: the error
 * `fetch` raised when there is one, because the client's own message names
 * only the request.
 */
const describeHttpError = (error: HttpClientError.HttpClientError): string =>
  describeError(error.cause ?? error);

/** Returns an error's message for a user, or the value as text when it is not an `Error`. */
const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Wraps the compressed body in a stream that fails past 64 MiB, and turns a
 * broken connection into `SkillSourceUnreadable`.
 */
const limitCompressedBytes = (
  body: Stream.Stream<Uint8Array, HttpClientError.HttpClientError>,
  repo: string,
): Stream.Stream<Uint8Array<ArrayBuffer>, SkillSourceUnreadable> =>
  Stream.suspend(() => {
    let received = 0;
    return body.pipe(
      Stream.mapError(
        (error) =>
          new SkillSourceUnreadable({
            message: `The connection to GitHub broke while downloading \`${repo}\`: ${describeHttpError(error)}. The next check tries again.`,
          }),
      ),
      Stream.mapEffect((chunk) => {
        received += chunk.byteLength;
        if (received > MAX_COMPRESSED_BYTES) {
          return Effect.fail(
            new SkillSourceUnreadable({
              message: `The download of \`${repo}\` from GitHub is over 64 MiB, more than a check reads. Skills in a repository this large cannot be checked for updates.`,
            }),
          );
        }
        // A response body's chunks are always backed by an `ArrayBuffer`,
        // which is what the decompressor's types ask for.
        return Effect.succeed(chunk as Uint8Array<ArrayBuffer>);
      }),
    );
  });

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
