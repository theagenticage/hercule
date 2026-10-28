import { describe, expect, it } from "vitest";
import { Duration, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { MAX_SKILL_BYTES } from "@hercule/protocol";
import { GithubSkillSources, GithubSkillSourcesLayer, type DownloadedSkillTree } from "./github";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const REPO = "acme/skills";
const ARCHIVE_URL = `https://codeload.github.com/${REPO}/tar.gz/${COMMIT}`;
const TOP = `skills-${COMMIT}/`;

/** One entry of a test tar archive. `type` is the ustar typeflag. */
interface TarEntry {
  readonly path: string;
  readonly type?: "0" | "2" | "5" | "g" | "x";
  readonly mode?: number;
  readonly content?: string | Uint8Array<ArrayBuffer>;
  readonly linkname?: string;
}

const encoder = new TextEncoder();

/** Builds a 512-byte ustar header with its checksum. */
const buildTarHeader = (entry: TarEntry, size: number): Uint8Array<ArrayBuffer> => {
  const header = new Uint8Array(512);
  const write = (offset: number, text: string) => header.set(encoder.encode(text), offset);
  const writeOctal = (offset: number, length: number, value: number) =>
    write(offset, `${value.toString(8).padStart(length - 1, "0")}\0`);
  write(0, entry.path);
  writeOctal(100, 8, entry.mode ?? 0o664);
  writeOctal(108, 8, 0);
  writeOctal(116, 8, 0);
  writeOctal(124, 12, size);
  writeOctal(136, 12, 0);
  write(156, entry.type ?? "0");
  write(157, entry.linkname ?? "");
  write(257, "ustar\0");
  write(263, "00");
  const sum = header.reduce(
    (total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte),
    0,
  );
  write(148, `${sum.toString(8).padStart(6, "0")}\0 `);
  return header;
};

/** Builds a pax record, whose length prefix counts the whole record, itself included. */
const buildPaxRecord = (key: string, value: string): string => {
  const body = ` ${key}=${value}\n`;
  let length = encoder.encode(body).length + 1;
  while (String(length).length + encoder.encode(body).length !== length) length++;
  return `${length}${body}`;
};

/**
 * Builds a gzip'd tar archive as codeload writes it: a pax global header with
 * the commit, then the entries. A path past 100 bytes gets a pax `x` header.
 */
const buildCodeloadArchive = async (
  entries: ReadonlyArray<TarEntry>,
): Promise<Uint8Array<ArrayBuffer>> => {
  const withHeaders: Array<TarEntry> = [
    { path: "pax_global_header", type: "g", content: buildPaxRecord("comment", COMMIT) },
  ];
  for (const entry of entries) {
    if (encoder.encode(entry.path).length > 100) {
      withHeaders.push({
        path: "PaxHeader",
        type: "x",
        content: buildPaxRecord("path", entry.path),
      });
      withHeaders.push({ ...entry, path: entry.path.slice(0, 100) });
    } else withHeaders.push(entry);
  }
  const blocks: Array<Uint8Array<ArrayBuffer>> = [];
  for (const entry of withHeaders) {
    const content =
      typeof entry.content === "string"
        ? encoder.encode(entry.content)
        : (entry.content ?? new Uint8Array(0));
    blocks.push(
      buildTarHeader(entry, content.length),
      content,
      new Uint8Array((512 - (content.length % 512)) % 512),
    );
  }
  blocks.push(new Uint8Array(1024));
  const gzipped = new Blob(blocks).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(gzipped).arrayBuffer());
};

/**
 * A fake GitHub: an `HttpClient` that answers each URL from `routes`, and 404
 * for any other URL. `requests` records every request it received.
 */
const fakeGithub = (routes: Record<string, () => Response>) => {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const client = HttpClient.make((request) => {
    requests.push(request);
    const response = routes[request.url]?.() ?? new Response("Not Found", { status: 404 });
    return Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });
  return { layer: Layer.succeed(HttpClient.HttpClient, client), requests };
};

type FakeGithub = ReturnType<typeof fakeGithub>;

/** Runs `use` on the GitHub Skill Sources service, reading the fake GitHub. */
const runAgainst = <A, E>(
  github: FakeGithub,
  use: (sources: GithubSkillSources["Service"]) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* GithubSkillSources);
    }).pipe(Effect.provide(GithubSkillSourcesLayer), Effect.provide(github.layer)),
  );

const archiveResponse = (archive: Uint8Array<ArrayBuffer>) => () =>
  new Response(new Blob([archive]));

const downloadTrees = (github: FakeGithub, paths: ReadonlyArray<string>) =>
  runAgainst(github, (sources) => sources.downloadSkillTrees(REPO, COMMIT, paths));

const downloadFailure = (github: FakeGithub, paths: ReadonlyArray<string> = ["skills/a"]) =>
  runAgainst(github, (sources) => Effect.flip(sources.downloadSkillTrees(REPO, COMMIT, paths)));

/** Returns a tree's entries as `path kind mode content` lines, for a readable comparison. */
const describeTree = (tree: DownloadedSkillTree | undefined) =>
  tree?._tag === "Tree"
    ? tree.entries.map(
        (entry) =>
          `${entry.path} ${entry.kind} ${entry.mode.toString(8)} ${new TextDecoder().decode(entry.content)}`,
      )
    : tree;

describe("readUpstreamCommit", () => {
  const commitUrl = `https://api.github.com/repos/${REPO}/commits/feature/new%20skill`;

  it("returns the branch's commit, asking GitHub for the bare commit id", async () => {
    const github = fakeGithub({ [commitUrl]: () => new Response(`${COMMIT}\n`) });
    const commit = await runAgainst(github, (sources) =>
      sources.readUpstreamCommit(REPO, "feature/new skill"),
    );
    expect(commit).toBe(COMMIT);
    expect(github.requests[0]!.headers).toHaveProperty("accept", "application/vnd.github.sha");
    expect(github.requests[0]!.headers).toHaveProperty("user-agent");
  });

  it("reads the default branch as HEAD", async () => {
    const github = fakeGithub({
      [`https://api.github.com/repos/${REPO}/commits/HEAD`]: () => new Response(COMMIT),
    });
    await expect(
      runAgainst(github, (sources) => sources.readUpstreamCommit(REPO, null)),
    ).resolves.toBe(COMMIT);
  });

  it.each([
    {
      case: "a missing or private repository",
      response: () => new Response("Not Found", { status: 404 }),
      message:
        "GitHub has no branch `feature/new skill` in `acme/skills`, or the repository is private. Only public repositories can be checked; check the repository and branch in the Skill Source.",
    },
    {
      case: "the rate limit for requests without a token",
      response: () =>
        new Response("rate limited", {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(Date.UTC(2026, 9, 18, 14, 5) / 1000),
          },
        }),
      message:
        "GitHub's limit on requests without a sign-in ran out for this controller's address. It resets at 14:05 UTC. The next check tries again.",
    },
    {
      case: "a body that is not a commit id",
      response: () => new Response("<html>hello</html>"),
      message:
        "GitHub returned something other than a commit id for `acme/skills`. The next check tries again.",
    },
  ])("fails with a message for the user on $case", async ({ response, message }) => {
    const error = await runAgainst(fakeGithub({ [commitUrl]: response }), (sources) =>
      Effect.flip(sources.readUpstreamCommit(REPO, "feature/new skill")),
    );
    expect(error.message).toBe(message);
  });
});

/**
 * Runs `use` on the GitHub Skill Sources service on Effect's real `fetch`
 * client, with `fetch` itself replaced, and a `TestClock`.
 */
const runOnFetch = <A, E>(
  fetch: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
  use: (sources: GithubSkillSources["Service"]) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* use(yield* GithubSkillSources);
    }).pipe(
      Effect.provide(GithubSkillSourcesLayer),
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch),
      Effect.provide(TestClock.layer()),
    ),
  );

describe("on the fetch client", () => {
  it("never lets fetch follow a redirect itself, so every redirect is checked for a GitHub host", async () => {
    const inits: Array<RequestInit | undefined> = [];
    await runOnFetch(
      (_url, init) => {
        inits.push(init);
        return Promise.resolve(new Response(COMMIT));
      },
      (sources) => sources.readUpstreamCommit(REPO, null),
    );
    expect(inits[0]?.redirect).toBe("manual");
  });

  it("stops a download that stalls after 2 minutes, and aborts the request", async () => {
    let signal: AbortSignal | undefined;
    let enter: () => void = () => {};
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const error = await runOnFetch(
      (_url, init) => {
        signal = init?.signal ?? undefined;
        enter();
        // The headers arrive, and then the body never sends a byte.
        return Promise.resolve(
          new Response(new ReadableStream({ pull: () => new Promise(() => {}) })),
        );
      },
      (sources) =>
        Effect.gen(function* () {
          const download = yield* Effect.forkChild(
            Effect.flip(sources.downloadSkillTrees(REPO, COMMIT, ["skills/a"])),
          );
          yield* Effect.promise(() => entered);
          yield* TestClock.adjust(Duration.minutes(2));
          return yield* Fiber.join(download);
        }),
    );
    expect(error.message).toBe(
      "Downloading `acme/skills` from GitHub took longer than 2 minutes, so the check stopped. The next check tries again.",
    );
    expect(signal?.aborted).toBe(true);
  });
});

describe("downloadSkillTrees", () => {
  it("returns each requested folder's entries, relative to the folder, with modes normalized", async () => {
    const longPath = `skills/a/${"deep/".repeat(25)}notes.md`;
    const archive = await buildCodeloadArchive([
      { path: TOP, type: "5", mode: 0o775 },
      { path: `${TOP}README.md`, content: "repo readme" },
      { path: `${TOP}skills/`, type: "5", mode: 0o775 },
      { path: `${TOP}skills/a/`, type: "5", mode: 0o775 },
      { path: `${TOP}skills/a/SKILL.md`, content: "skill a" },
      { path: `${TOP}skills/a/run.sh`, mode: 0o775, content: "#!/bin/sh" },
      { path: `${TOP}skills/a/link`, type: "2", mode: 0o777, linkname: "SKILL.md" },
      { path: `${TOP}${longPath}`, content: "long" },
      { path: `${TOP}skills/ab/SKILL.md`, content: "not a" },
      { path: `${TOP}skills/b/SKILL.md`, content: "skill b" },
    ]);
    const trees = await downloadTrees(fakeGithub({ [ARCHIVE_URL]: archiveResponse(archive) }), [
      "skills/a",
      "skills/b/",
      "",
    ]);
    expect(describeTree(trees.get("skills/a"))).toEqual([
      "SKILL.md file 644 skill a",
      "run.sh file 755 #!/bin/sh",
      "link symlink 755 ",
      `${longPath.slice("skills/a/".length)} file 644 long`,
    ]);
    expect(describeTree(trees.get("skills/b/"))).toEqual(["SKILL.md file 644 skill b"]);
    expect(describeTree(trees.get(""))).toContain("README.md file 644 repo readme");
  });

  it("refuses a folder the commit does not have, and still returns the others", async () => {
    const archive = await buildCodeloadArchive([{ path: `${TOP}skills/a/SKILL.md`, content: "a" }]);
    const trees = await downloadTrees(fakeGithub({ [ARCHIVE_URL]: archiveResponse(archive) }), [
      "skills/a",
      "skills/gone",
    ]);
    expect(trees.get("skills/a")?._tag).toBe("Tree");
    expect(trees.get("skills/gone")).toEqual({
      _tag: "Refused",
      reason:
        "`acme/skills` has no folder `skills/gone` at commit 0123456. Check the path in the Skill Source.",
    });
  });

  it("refuses a folder over the 10 MiB cap", async () => {
    const archive = await buildCodeloadArchive([
      { path: `${TOP}skills/a/SKILL.md`, content: "a" },
      { path: `${TOP}skills/a/big.bin`, content: new Uint8Array(MAX_SKILL_BYTES) },
    ]);
    const trees = await downloadTrees(fakeGithub({ [ARCHIVE_URL]: archiveResponse(archive) }), [
      "skills/a",
    ]);
    expect(trees.get("skills/a")).toEqual({
      _tag: "Refused",
      reason:
        "The folder `skills/a` is 10.1 MiB as a tar archive at commit 0123456. A skill's archive may be at most 10 MiB.",
    });
  });

  it("counts links toward a folder's caps, and refuses a folder of more than 1,000 entries", async () => {
    const links = Array.from({ length: 25_000 }, (_, index) => ({
      path: `${TOP}skills/a/link-${index}`,
      type: "2" as const,
      linkname: "SKILL.md",
    }));
    const archive = await buildCodeloadArchive([
      { path: `${TOP}skills/a/SKILL.md`, content: "a" },
      ...links,
    ]);
    const trees = await downloadTrees(fakeGithub({ [ARCHIVE_URL]: archiveResponse(archive) }), [
      "skills/a",
    ]);
    expect(trees.get("skills/a")).toEqual({
      _tag: "Refused",
      reason:
        "The folder `skills/a` has 25,001 files at commit 0123456. A skill holds at most 1,000; remove the files it does not need.",
    });
  });

  it("fails when the requested folders together hold more than one download keeps", async () => {
    const folders = Array.from({ length: 7 }, (_, index) => `skills/s${index}`);
    const archive = await buildCodeloadArchive(
      folders.map((folder) => ({
        path: `${TOP}${folder}/big.bin`,
        content: new Uint8Array(MAX_SKILL_BYTES - 64 * 1024),
      })),
    );
    const error = await downloadFailure(
      fakeGithub({ [ARCHIVE_URL]: archiveResponse(archive) }),
      folders,
    );
    expect(error.message).toBe(
      "The skill folders this check reads from `acme/skills` hold more than 64 MiB together, more than one check keeps. Check fewer skills from this repository, or make them smaller.",
    );
  });

  it("follows a redirect to another GitHub host", async () => {
    const archive = await buildCodeloadArchive([{ path: `${TOP}skills/a/SKILL.md`, content: "a" }]);
    const mirror = `https://github.com/${REPO}/archive/${COMMIT}.tar.gz`;
    const github = fakeGithub({
      [ARCHIVE_URL]: () => new Response(null, { status: 302, headers: { location: mirror } }),
      [mirror]: archiveResponse(archive),
    });
    expect(describeTree((await downloadTrees(github, ["skills/a"])).get("skills/a"))).toEqual([
      "SKILL.md file 644 a",
    ]);
  });

  it.each([
    {
      case: "a redirect away from GitHub",
      response: () =>
        new Response(null, { status: 302, headers: { location: "https://evil.example/x.tar.gz" } }),
      message:
        "GitHub redirected the request to evil.example, which is not a GitHub address, so the check stopped.",
    },
    {
      case: "a body that is not gzip",
      response: () => new Response("this is not gzip at all"),
      message:
        "The download of `acme/skills` from GitHub is not a valid gzip file. The next check tries again.",
    },
    {
      case: "a download past the compressed cap",
      response: () => new Response(streamEndlessGzip()),
      message:
        "The download of `acme/skills` from GitHub is over 64 MiB, more than a check reads. Skills in a repository this large cannot be checked for updates.",
    },
  ])("fails with a message for the user on $case", async ({ response, message }) => {
    const error = await downloadFailure(fakeGithub({ [ARCHIVE_URL]: response }));
    expect(error.message).toBe(message);
  });
});

/**
 * Streams a gzip file that never ends: a gzip header, then deflate blocks
 * stored without compression, so each compressed byte is one decompressed
 * byte. The first block holds a tar header for a 1 GiB file outside every
 * requested folder, and the blocks after it hold zeros.
 */
const streamEndlessGzip = (): ReadableStream<Uint8Array> => {
  const storedBlock = (data: Uint8Array) => {
    const block = new Uint8Array(5 + data.length);
    block.set([
      0,
      data.length & 0xff,
      data.length >> 8,
      ~data.length & 0xff,
      (~data.length >> 8) & 0xff,
    ]);
    block.set(data, 5);
    return block;
  };
  const zeros = storedBlock(new Uint8Array(65_535));
  let started = false;
  return new ReadableStream({
    pull(controller) {
      if (started) return controller.enqueue(zeros);
      started = true;
      controller.enqueue(new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]));
      controller.enqueue(storedBlock(buildTarHeader({ path: `${TOP}huge.bin` }, 1024 ** 3)));
    },
  });
};
