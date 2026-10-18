/**
 * Test helpers for the Skill Library: building a skill's archive, importing
 * it over HTTP, the way a user does, and a fake GitHub for the update check.
 */
import { expect } from "vitest";
import { Deferred, Effect } from "effect";
import type { Skill } from "@hercule/contract";
import { buildSkillArchive, type SkillFile } from "@hercule/protocol";
import { SkillSourceUnreadable, type DownloadedSkillTree, type GithubSkillSources } from "./github";

/**
 * Builds the archive of a skill named `name` with one `SKILL.md`. Its body is
 * `body`, so two calls with different bodies build two different revisions.
 */
export const buildTestSkillArchive = (name: string, body = "Body"): Promise<Uint8Array> =>
  Effect.runPromise(
    buildSkillArchive([
      {
        path: "SKILL.md",
        mode: "644",
        content: new TextEncoder().encode(
          `---\nname: ${name}\ndescription: Teaches.\n---\n${body}\n`,
        ),
      },
    ]),
  );

/**
 * Imports the skill `name` as the user, with `body` as its `SKILL.md` body,
 * and returns the Skill the import answers. `replace` makes new content
 * current over a Skill that has other content, and `source` gives the Skill a
 * GitHub source. Fails the test when the import does not answer `200`.
 */
export const importTestSkill = async (
  base: string,
  token: string,
  name: string,
  options: {
    readonly body?: string;
    readonly replace?: true;
    readonly source?: { readonly repo: string; readonly path: string };
  } = {},
): Promise<Skill> => {
  const query = new URLSearchParams({ name });
  if (options.replace === true) query.set("replace", "true");
  if (options.source !== undefined) {
    query.set("sourceRepo", options.source.repo);
    query.set("sourcePath", options.source.path);
  }
  const response = await fetch(`${base}/api/v1/skills/import?${query.toString()}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", authorization: `Bearer ${token}` },
    body: await buildTestSkillArchive(name, options.body),
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { readonly skill: Skill }).skill;
};

/**
 * A fake GitHub with one branch, shared by every repository. A test points it
 * at a commit with the skill folders that commit holds, and reads back what
 * the update check asked for.
 */
export interface FakeGithub {
  readonly service: GithubSkillSources["Service"];
  /**
   * Points the branch at `commit`, whose folders, keyed by path, hold these
   * files. A path left out has no folder at that commit.
   */
  readonly pushCommit: (
    commit: string,
    folders: Readonly<Record<string, ReadonlyArray<SkillFile>>>,
  ) => void;
  /** Makes every read fail with `message`, or succeed again with `undefined`. */
  readonly failReads: (message: string | undefined) => void;
  /**
   * Holds the next commit read until the returned `release` runs. `entered`
   * completes once the read has started.
   */
  readonly holdNextCommitRead: () => {
    readonly entered: Deferred.Deferred<void>;
    readonly release: Effect.Effect<void>;
  };
  /** The repository of each commit read the check made, in the order they began. */
  readonly commitReads: () => ReadonlyArray<string>;
  /** The most commit reads that were running at the same time. */
  readonly mostConcurrentCommitReads: () => number;
  /** The repository and paths of each download, in the order they began. */
  readonly downloads: () => ReadonlyArray<{
    readonly repo: string;
    readonly paths: ReadonlyArray<string>;
  }>;
}

/** Converts a skill's files to the entries a downloaded tree holds. */
const buildTreeEntries = (files: ReadonlyArray<SkillFile>) =>
  files.map((file) => ({
    path: file.path,
    kind: "file" as const,
    mode: file.mode === "755" ? 0o755 : 0o644,
    content: file.content,
  }));

/** Builds a fake GitHub whose branch points at no commit until `pushCommit` runs. */
export const makeFakeGithub = (): FakeGithub => {
  let commit = "0".repeat(40);
  let folders: Readonly<Record<string, ReadonlyArray<SkillFile>>> = {};
  let failure: string | undefined;
  let hold: { entered: Deferred.Deferred<void>; released: Deferred.Deferred<void> } | undefined;
  const commitReads: Array<string> = [];
  let runningCommitReads = 0;
  let mostConcurrentCommitReads = 0;
  const downloads: Array<{ readonly repo: string; readonly paths: ReadonlyArray<string> }> = [];
  const failIfAsked = Effect.suspend(() =>
    failure === undefined
      ? Effect.void
      : Effect.fail(new SkillSourceUnreadable({ message: failure })),
  );
  return {
    service: {
      readUpstreamCommit: (repo) =>
        Effect.gen(function* () {
          commitReads.push(repo);
          runningCommitReads += 1;
          mostConcurrentCommitReads = Math.max(mostConcurrentCommitReads, runningCommitReads);
          // A real read waits on the network, so other fibers run meanwhile.
          yield* Effect.yieldNow;
          const held = hold;
          hold = undefined;
          if (held !== undefined) {
            yield* Deferred.succeed(held.entered, undefined);
            yield* Deferred.await(held.released);
          }
          runningCommitReads -= 1;
          yield* failIfAsked;
          return commit;
        }),
      downloadSkillTrees: (repo, _commit, paths) =>
        Effect.gen(function* () {
          downloads.push({ repo, paths });
          yield* failIfAsked;
          return new Map(
            paths.map((path): [string, DownloadedSkillTree] => {
              const files = folders[path];
              return [
                path,
                files === undefined
                  ? { _tag: "Refused", reason: `there is no folder \`${path}\`` }
                  : { _tag: "Tree", entries: buildTreeEntries(files) },
              ];
            }),
          );
        }),
    },
    pushCommit: (next, nextFolders) => {
      commit = next;
      folders = nextFolders;
    },
    failReads: (message) => {
      failure = message;
    },
    holdNextCommitRead: () => {
      const entered = Deferred.makeUnsafe<void>();
      const released = Deferred.makeUnsafe<void>();
      hold = { entered, released };
      return { entered, release: Deferred.succeed(released, undefined).pipe(Effect.asVoid) };
    },
    commitReads: () => commitReads,
    mostConcurrentCommitReads: () => mostConcurrentCommitReads,
    downloads: () => downloads,
  };
};
