/**
 * Tearing a workspace down. The branch outlives the directory, a
 * primary is never torn down at all, and a dispose of something that is
 * already gone is still a dispose.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makeWorkspaces } from "./index";
import {
  adoptedCheckout,
  checkout,
  cleanTemporaries,
  contentsOf,
  git,
  id,
  makeRemote,
  provisionFrame,
  temporary,
} from "./testing";

afterAll(cleanTemporaries);

const storage = (): string => temporary("hydra-storage-");

const disposing = (workspaceId: string) => ({ _tag: "workspaceDispose", workspaceId }) as const;

describe("disposing an ephemeral workspace", () => {
  it("removes the worktree and the directory, and keeps the branch in the cache", async () => {
    const remote = makeRemote();
    const storageDir = storage();
    const workspaceId = id();
    const resourceId = id();
    const workspaces = makeWorkspaces({ storageDir });
    await workspaces.provision(
      provisionFrame({
        workspaceId,
        kind: "ephemeral",
        checkouts: [checkout({ resourceId, remote: remote.url, branch: "hydra/run-4d4d4d4d" })],
      }),
    );
    const directory = join(storageDir, "workspaces", workspaceId);
    const cache = join(storageDir, "cache", `${resourceId}.git`);

    const report = await workspaces.dispose(disposing(workspaceId));

    expect(report.status).toBe("deleted");
    expect(report.workspaceId).toBe(workspaceId);
    expect(existsSync(directory)).toBe(false);
    // The work the agent did is not thrown away with the directory.
    expect(git(cache, "rev-parse", "--verify", "hydra/run-4d4d4d4d")).toMatch(/^[0-9a-f]{40}$/);
    // And git no longer believes a worktree lives there.
    expect(git(cache, "worktree", "list")).not.toContain(directory);
    // A restart must not resurrect it.
    expect(makeWorkspaces({ storageDir }).resolve(workspaceId)).toBeUndefined();
  });
});

describe("disposing a primary", () => {
  it("refuses, and touches the user's folder not at all", async () => {
    const remote = makeRemote();
    const folder = adoptedCheckout(remote);
    const storageDir = storage();
    const workspaceId = id();
    const workspaces = makeWorkspaces({ storageDir });
    await workspaces.provision(
      provisionFrame({
        workspaceId,
        kind: "primary",
        checkouts: [checkout({ resourceId: id(), remote: remote.url, path: folder })],
      }),
    );
    const before = contentsOf(folder);

    const report = await workspaces.dispose(disposing(workspaceId));

    expect(report.status).toBe("failed");
    expect(report.message).toBe("a primary is never torn down");
    expect(existsSync(folder)).toBe(true);
    expect(contentsOf(folder)).toBe(before);
    // Still the runner's, so a session can still be placed in it.
    expect(workspaces.resolve(workspaceId)?.cwd).toBe(folder);
  });
});

describe("disposing something this runner never had", () => {
  it("reports deleted rather than failing", async () => {
    const workspaceId = id();

    const report = await makeWorkspaces({ storageDir: storage() }).dispose(disposing(workspaceId));

    // The controller must be able to retry a dispose it did not see answered.
    expect(report.status).toBe("deleted");
    expect(report.workspaceId).toBe(workspaceId);
  });
});
