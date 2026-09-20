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

const storage = (): string => temporary("hercule-storage-");

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
        checkouts: [checkout({ resourceId, remote: remote.url, branch: "hercule/run-4d4d4d4d" })],
      }),
    );
    const directory = join(storageDir, "workspaces", workspaceId);
    const cache = join(storageDir, "cache", `${resourceId}.git`);

    const report = await workspaces.dispose(disposing(workspaceId));

    expect(report.status).toBe("deleted");
    expect(report.workspaceId).toBe(workspaceId);
    expect(existsSync(directory)).toBe(false);
    // The work the agent did is not thrown away with the directory.
    expect(git(cache, "rev-parse", "--verify", "hercule/run-4d4d4d4d")).toMatch(/^[0-9a-f]{40}$/);
    // And git no longer believes a worktree lives there.
    expect(git(cache, "worktree", "list")).not.toContain(directory);
    // A restart must not resurrect it.
    expect(makeWorkspaces({ storageDir }).resolve(workspaceId)).toBeUndefined();
  });
});

describe("disposing a primary", () => {
  // D-20a: a primary is always Hercule's own clone, so what must survive a dispose
  // is that clone rather than a folder of the user's that was adopted.
  it("refuses, and leaves the main workspace where it is", async () => {
    const remote = makeRemote();
    const storageDir = storage();
    const workspaceId = id();
    const resourceId = id();
    const workspaces = makeWorkspaces({ storageDir });
    await workspaces.provision(
      provisionFrame({
        workspaceId,
        kind: "primary",
        checkouts: [checkout({ resourceId, remote: remote.url })],
      }),
    );
    const directory = join(storageDir, "primaries", resourceId);
    const before = contentsOf(directory);

    const report = await workspaces.dispose(disposing(workspaceId));

    expect(report.status).toBe("failed");
    expect(report.message).toBe("a primary is never torn down");
    expect(existsSync(directory)).toBe(true);
    expect(contentsOf(directory)).toBe(before);
    // Still the runner's, so a session can still be placed in it.
    expect(workspaces.resolve(workspaceId)?.cwd).toBe(directory);
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

describe("disposing a workspace that is still being provisioned", () => {
  /**
   * D-21 R6: the two frames can arrive together, and a dispose that overtook
   * the provisioning would remove a directory git was still writing into - and
   * the provisioning would then register what the dispose had just removed.
   */
  it("waits for the provisioning to finish, then leaves nothing behind", async () => {
    const remote = makeRemote();
    const storageDir = storage();
    const workspaceId = id();
    const workspaces = makeWorkspaces({ storageDir });
    const frame = provisionFrame({
      workspaceId,
      kind: "ephemeral",
      checkouts: [checkout({ resourceId: id(), remote: remote.url, branch: "hercule/run-2e2e2e2e" })],
    });

    const [, disposed] = await Promise.all([
      workspaces.provision(frame),
      workspaces.dispose(disposing(workspaceId)),
    ]);

    expect(disposed.status).toBe("deleted");
    expect(existsSync(join(storageDir, "workspaces", workspaceId))).toBe(false);
    // And nothing of it is still registered, so no session can be placed there.
    expect(makeWorkspaces({ storageDir }).resolve(workspaceId)).toBeUndefined();
  });
});
