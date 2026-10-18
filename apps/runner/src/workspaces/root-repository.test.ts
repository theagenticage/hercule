/**
 * Tests for the empty repository at the root of a workspace with no single
 * checkout:
 *
 * - it is made once, holds and tracks nothing, and a second call changes nothing,
 * - an existing `.git` is never touched,
 * - a failed attempt leaves nothing behind,
 * - disposing the workspace removes the root with its `.git`, and still
 *   refuses to delete a file someone put there.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterAll, describe, expect, it } from "vitest";
import { buildSubstrateEnv } from "./substrate";
import { ensureRootRepository } from "./root-repository";
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

const env = buildSubstrateEnv(process.env, {});

describe("ensureRootRepository", () => {
  it("makes the folder a repository with no commit that ignores everything in it", async () => {
    const root = createTemporaryDir("hercule-root-");
    writeFileSync(join(root, "note.txt"), "a file in the root");

    await Effect.runPromise(ensureRootRepository(root, env));

    expect(readFileSync(join(root, ".git", "info", "exclude"), "utf8")).toBe("*\n");
    expect(runGitOrThrow(root, "status", "--porcelain")).toBe("");
    expect(runGitOrThrow(root, "rev-parse", "--is-inside-work-tree")).toBe("true");
  });

  it("changes nothing when it runs again", async () => {
    const root = createTemporaryDir("hercule-root-");
    await Effect.runPromise(ensureRootRepository(root, env));
    const before = hashContents(root);

    await Effect.runPromise(ensureRootRepository(root, env));

    expect(hashContents(root)).toBe(before);
  });

  it("leaves a .git that is already there as it is", async () => {
    const root = createTemporaryDir("hercule-root-");
    runGitOrThrow(root, "init", "--quiet");
    const before = hashContents(root);

    await Effect.runPromise(ensureRootRepository(root, env));

    expect(hashContents(root)).toBe(before);
    expect(readFileSync(join(root, ".git", "info", "exclude"), "utf8")).not.toBe("*\n");
  });

  it("fails with git's reason and leaves no .git when the folder cannot be written", async () => {
    const root = createTemporaryDir("hercule-root-");
    chmodSync(root, 0o500);
    try {
      const error = await Effect.runPromise(Effect.flip(ensureRootRepository(root, env)));
      expect(error.message).toMatch(/^git init failed: .+/);
    } finally {
      chmodSync(root, 0o700);
    }
    expect(existsSync(join(root, ".git"))).toBe(false);
  });
});

describe("disposing a workspace whose root is a repository", () => {
  /** Provisions an ephemeral workspace with `count` checkouts and makes its root a repository. */
  const provisionWithRootRepository = async (count: number) => {
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
    await Effect.runPromise(ensureRootRepository(root, env));
    return { workspaces, workspaceId, root };
  };

  it.each([0, 2])(
    "removes the root of a workspace with %i checkouts, .git included",
    async (count) => {
      const { workspaces, workspaceId, root } = await provisionWithRootRepository(count);

      const report = await Effect.runPromise(
        workspaces.dispose({ _tag: "workspaceDispose", workspaceId }),
      );

      expect(report.status).toBe("deleted");
      expect(existsSync(root)).toBe(false);
    },
  );

  it("removes the root when the disposal discards changes", async () => {
    const { workspaces, workspaceId, root } = await provisionWithRootRepository(2);

    const report = await Effect.runPromise(
      workspaces.dispose({ _tag: "workspaceDispose", workspaceId, discardChanges: true }),
    );

    expect(report.status).toBe("deleted");
    expect(existsSync(root)).toBe(false);
  });

  it("still refuses to delete a file that someone put in the root", async () => {
    const { workspaces, workspaceId, root } = await provisionWithRootRepository(0);
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "notes", "plan.md"), "keep me");

    const report = await Effect.runPromise(
      workspaces.dispose({ _tag: "workspaceDispose", workspaceId }),
    );

    expect(report.status).not.toBe("deleted");
    expect(readFileSync(join(root, "notes", "plan.md"), "utf8")).toBe("keep me");
  });
});
