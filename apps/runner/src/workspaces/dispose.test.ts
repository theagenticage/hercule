import { makeTestWorkspaces } from "./testing";
import * as Effect from "effect/Effect";
/**
 * Tests for disposing a workspace:
 *
 * - the branch is kept after the directory and the step result files are removed,
 * - a primary is never torn down,
 * - disposing a workspace that is already gone still succeeds.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  buildCheckout,
  cleanTemporaries,
  hashContents,
  runGitOrThrow,
  createId,
  makeRemote,
  buildProvisionFrame,
  createTemporaryDir,
} from "./testing";

afterAll(cleanTemporaries);

const createStorageDir = (): string => createTemporaryDir("hercule-storage-");

const buildDisposeFrame = (workspaceId: string) =>
  ({ _tag: "workspaceDispose", workspaceId }) as const;

describe("disposing an ephemeral workspace", () => {
  it("removes the worktree and the directory, and keeps the branch in the cache", async () => {
    const remote = makeRemote();
    const storageDir = createStorageDir();
    const workspaceId = createId();
    const resourceId = createId();
    const workspaces = makeTestWorkspaces({ storageDir });
    await Effect.runPromise(
      workspaces.provision(
        buildProvisionFrame({
          workspaceId,
          kind: "ephemeral",
          checkouts: [
            buildCheckout({ resourceId, remote: remote.url, branch: "hercule/run-4d4d4d4d" }),
          ],
        }),
      ),
    );
    const directory = join(storageDir, "workspaces", workspaceId);
    const cache = join(storageDir, "cache", `${resourceId}.git`);
    // A result file of one of the workspace's steps, which lives outside the
    // workspace directory.
    const stepResults = join(storageDir, "step-results", workspaceId);
    mkdirSync(stepResults, { recursive: true });
    writeFileSync(join(stepResults, "run-commit-1.json"), "{}");

    const report = await Effect.runPromise(workspaces.dispose(buildDisposeFrame(workspaceId)));

    expect(report.status).toBe("deleted");
    expect(report.workspaceId).toBe(workspaceId);
    expect(existsSync(directory)).toBe(false);
    // No step of a disposed workspace is asked about again.
    expect(existsSync(stepResults)).toBe(false);
    // The work the agent did is not thrown away with the directory.
    expect(runGitOrThrow(cache, "rev-parse", "--verify", "hercule/run-4d4d4d4d")).toMatch(
      /^[0-9a-f]{40}$/,
    );
    // And git no longer lists a worktree there.
    expect(runGitOrThrow(cache, "worktree", "list")).not.toContain(directory);
    // A restart must not resurrect it.
    expect(Effect.runSync(makeTestWorkspaces({ storageDir }).resolve(workspaceId))).toBeUndefined();
  });
});

describe("disposing a primary", () => {
  // A primary is always Hercule's own clone, so this checks that the clone
  // survives the dispose.
  it("fails, and leaves the main workspace untouched", async () => {
    const remote = makeRemote();
    const storageDir = createStorageDir();
    const workspaceId = createId();
    const resourceId = createId();
    const workspaces = makeTestWorkspaces({ storageDir });
    await Effect.runPromise(
      workspaces.provision(
        buildProvisionFrame({
          workspaceId,
          kind: "primary",
          checkouts: [buildCheckout({ resourceId, remote: remote.url })],
        }),
      ),
    );
    const directory = join(storageDir, "primaries", workspaceId);
    const before = hashContents(directory);

    const report = await Effect.runPromise(workspaces.dispose(buildDisposeFrame(workspaceId)));

    expect(report.status).toBe("failed");
    expect(report.message).toMatch(/explicit discard changes/i);
    expect(existsSync(directory)).toBe(true);
    expect(hashContents(directory)).toBe(before);
    // Still registered, so a session can still be placed in it.
    expect(Effect.runSync(workspaces.resolve(workspaceId))?.cwd).toBe(directory);
  });
});

describe("disposing something this runner never had", () => {
  it("reports deleted rather than failing", async () => {
    const workspaceId = createId();

    const report = await Effect.runPromise(
      makeTestWorkspaces({ storageDir: createStorageDir() }).dispose(
        buildDisposeFrame(workspaceId),
      ),
    );

    // The controller must be able to retry a dispose it did not see answered.
    expect(report.status).toBe("deleted");
    expect(report.workspaceId).toBe(workspaceId);
  });
});

describe("disposing a workspace that is still being provisioned", () => {
  /**
   * The two frames can arrive together. A dispose that ran before the
   * provisioning finished would remove a directory git was still writing into,
   * and the provisioning would then register the directory the dispose had
   * just removed.
   */
  it("waits for the provisioning to finish, then leaves nothing behind", async () => {
    const remote = makeRemote();
    const storageDir = createStorageDir();
    const workspaceId = createId();
    const workspaces = makeTestWorkspaces({ storageDir });
    const frame = buildProvisionFrame({
      workspaceId,
      kind: "ephemeral",
      checkouts: [
        buildCheckout({
          resourceId: createId(),
          remote: remote.url,
          branch: "hercule/run-2e2e2e2e",
        }),
      ],
    });

    const [, disposed] = await Promise.all([
      Effect.runPromise(workspaces.provision(frame)),
      Effect.runPromise(workspaces.dispose(buildDisposeFrame(workspaceId))),
    ]);

    expect(disposed.status).toBe("deleted");
    expect(existsSync(join(storageDir, "workspaces", workspaceId))).toBe(false);
    // And nothing of it is still registered, so no session can be placed there.
    expect(Effect.runSync(makeTestWorkspaces({ storageDir }).resolve(workspaceId))).toBeUndefined();
  });
});
