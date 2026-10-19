/**
 * Tests for the boundary at the root of a workspace with no single checkout,
 * an empty `.git` file:
 *
 * - it is made once, holds nothing, and a second call changes nothing,
 * - two calls at the same time both succeed and leave one file,
 * - an existing `.git` of any kind is never touched,
 * - a root that cannot be written fails with the cause,
 * - disposing the workspace removes the file with the root, and refuses to
 *   remove a `.git` that is a directory or holds bytes.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterAll, describe, expect, it } from "vitest";
import { ensureRootBoundary } from "./root-boundary";
import {
  buildCheckout,
  buildProvisionFrame,
  cleanTemporaries,
  createId,
  createTemporaryDir,
  hashContents,
  makeRemote,
  makeTestWorkspaces,
  runGitOrThrow,
} from "./testing";

afterAll(cleanTemporaries);

describe("ensureRootBoundary", () => {
  it("makes an empty regular file named .git", async () => {
    const root = createTemporaryDir("hercule-root-");
    writeFileSync(join(root, "note.txt"), "a file in the root");

    await Effect.runPromise(ensureRootBoundary(root));

    const entry = lstatSync(join(root, ".git"));
    expect(entry.isFile()).toBe(true);
    expect(entry.size).toBe(0);
  });

  it("changes nothing when it runs again", async () => {
    const root = createTemporaryDir("hercule-root-");
    await Effect.runPromise(ensureRootBoundary(root));
    const before = hashContents(root);

    await Effect.runPromise(ensureRootBoundary(root));

    expect(hashContents(root)).toBe(before);
  });

  it("succeeds in every one of many starts at the same time, and leaves the file", async () => {
    for (let round = 0; round < 20; round += 1) {
      const root = createTemporaryDir("hercule-root-");

      await Effect.runPromise(
        Effect.all(
          Array.from({ length: 8 }, () => ensureRootBoundary(root)),
          { concurrency: "unbounded" },
        ),
      );

      expect(lstatSync(join(root, ".git")).size).toBe(0);
    }
  });

  it("leaves a .git repository that is already there as it is", async () => {
    const root = createTemporaryDir("hercule-root-");
    runGitOrThrow(root, "init", "--quiet");
    const before = hashContents(root);

    await Effect.runPromise(ensureRootBoundary(root));

    expect(hashContents(root)).toBe(before);
    expect(lstatSync(join(root, ".git")).isDirectory()).toBe(true);
  });

  it("leaves a .git file that holds bytes as it is", async () => {
    const root = createTemporaryDir("hercule-root-");
    writeFileSync(join(root, ".git"), "gitdir: /somewhere/else\n");

    await Effect.runPromise(ensureRootBoundary(root));

    expect(readFileSync(join(root, ".git"), "utf8")).toBe("gitdir: /somewhere/else\n");
  });

  it("fails with the cause and leaves no .git when the folder cannot be written", async () => {
    const root = createTemporaryDir("hercule-root-");
    chmodSync(root, 0o500);
    try {
      const error = await Effect.runPromise(Effect.flip(ensureRootBoundary(root)));
      expect(error.message).toBe(
        "the .git file that marks the workspace folder could not be created (EACCES)",
      );
    } finally {
      chmodSync(root, 0o700);
    }
    expect(existsSync(join(root, ".git"))).toBe(false);
  });
});

describe("disposing a workspace whose root has the boundary file", () => {
  /** Provisions an ephemeral workspace with `count` checkouts and gives its root the boundary file. */
  const provisionWithRootBoundary = async (count: number) => {
    const storageDir = createTemporaryDir("hercule-storage-");
    const workspaceId = createId();
    const workspaces = makeTestWorkspaces({ storageDir });
    await Effect.runPromise(
      workspaces.provision(
        buildProvisionFrame({
          workspaceId,
          kind: "ephemeral",
          checkouts: Array.from({ length: count }, (_, at) =>
            buildCheckout({
              resourceId: createId(),
              remote: makeRemote().url,
              subdirectory: `repo-${String(at)}`,
              branch: `work-${createId()}`,
            }),
          ),
        }),
      ),
    );
    const root = join(storageDir, "workspaces", workspaceId);
    await Effect.runPromise(ensureRootBoundary(root));
    return { workspaces, workspaceId, root };
  };

  it.each([0, 2])(
    "removes the root of a workspace with %i checkouts, the .git file included",
    async (count) => {
      const { workspaces, workspaceId, root } = await provisionWithRootBoundary(count);

      const report = await Effect.runPromise(
        workspaces.dispose({ _tag: "workspaceDispose", workspaceId }),
      );

      expect(report.status).toBe("deleted");
      expect(existsSync(root)).toBe(false);
    },
  );

  it("removes the root when the disposal discards changes", async () => {
    const { workspaces, workspaceId, root } = await provisionWithRootBoundary(2);

    const report = await Effect.runPromise(
      workspaces.dispose({ _tag: "workspaceDispose", workspaceId, discardChanges: true }),
    );

    expect(report.status).toBe("deleted");
    expect(existsSync(root)).toBe(false);
  });

  it("still refuses to delete a file that someone put in the root", async () => {
    const { workspaces, workspaceId, root } = await provisionWithRootBoundary(0);
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "notes", "plan.md"), "keep me");

    const report = await Effect.runPromise(
      workspaces.dispose({ _tag: "workspaceDispose", workspaceId }),
    );

    expect(report.status).not.toBe("deleted");
    expect(readFileSync(join(root, "notes", "plan.md"), "utf8")).toBe("keep me");
  });

  it("refuses to delete a .git directory with a commit that an agent made in the root", async () => {
    const { workspaces, workspaceId, root } = await provisionWithRootBoundary(0);
    rmSync(join(root, ".git"));
    runGitOrThrow(root, "init", "--quiet");
    writeFileSync(join(root, "work.txt"), "an agent's work");
    runGitOrThrow(root, "add", "-f", "work.txt");
    runGitOrThrow(
      root,
      "-c",
      "user.name=Agent",
      "-c",
      "user.email=agent@example.com",
      "commit",
      "--quiet",
      "-m",
      "work",
    );

    const report = await Effect.runPromise(
      workspaces.dispose({ _tag: "workspaceDispose", workspaceId }),
    );

    expect(report.status).not.toBe("deleted");
    expect(runGitOrThrow(root, "log", "--format=%s")).toBe("work");
  });

  it("refuses to delete a .git file that holds bytes", async () => {
    const { workspaces, workspaceId, root } = await provisionWithRootBoundary(0);
    writeFileSync(join(root, ".git"), "gitdir: /somewhere/else\n");

    const report = await Effect.runPromise(
      workspaces.dispose({ _tag: "workspaceDispose", workspaceId }),
    );

    expect(report.status).not.toBe("deleted");
    expect(readFileSync(join(root, ".git"), "utf8")).toBe("gitdir: /somewhere/else\n");
  });
});
