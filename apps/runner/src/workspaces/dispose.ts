/**
 * Tears down an ephemeral workspace. The branch the agent worked on stays in
 * the cache, so nothing the agent committed is lost with the directory. A
 * primary is never torn down: it is the long-lived main workspace that
 * sessions share.
 */
import { readdirSync, rmSync } from "node:fs";
import { join as joinPath } from "node:path";
import type { WorkspaceDispose, WorkspaceReport } from "@hercule/protocol";
import { buildCacheDir, buildCacheRoot, pruneWorktrees, removeWorktree } from "./git";
import type { GitEnv } from "./git";
import type { RegisteredCheckout } from "./registry";
import type { Substrate } from "./substrate";

/**
 * Removes a workspace from disk, in this order:
 *
 * 1. Removes each checkout's worktree.
 * 2. Deletes the workspace directory.
 * 3. Prunes each checkout's cache, so git forgets the worktrees.
 *
 * The order matters: a prune only forgets worktrees whose directories are
 * already gone, so pruning earlier would leave git with records of
 * directories deleted afterwards. Disposing a workspace and cleaning up after
 * a failed provisioning both call this, so the order is written only once.
 */
export const tearDown = async (
  storageDir: string,
  root: string,
  checkouts: ReadonlyArray<RegisteredCheckout>,
  env: GitEnv,
): Promise<void> => {
  for (const one of checkouts) {
    await removeWorktree(buildCacheDir(storageDir, one.resourceId), one.path, env);
  }
  rmSync(root, { recursive: true, force: true });
  for (const one of checkouts) {
    await pruneWorktrees(buildCacheDir(storageDir, one.resourceId), env);
  }
};

/**
 * Prunes every cache on this runner. This cleans up after a failed
 * provisioning, which can leave a worktree recorded in a cache without a
 * registry entry that says which cache. While a cache still records a worktree
 * whose directory is gone, git fails to create another worktree at that path.
 */
const pruneEveryCache = async (substrate: Substrate): Promise<void> => {
  let caches: ReadonlyArray<string>;
  try {
    caches = readdirSync(buildCacheRoot(substrate.storageDir));
  } catch {
    return;
  }
  for (const cache of caches) {
    await pruneWorktrees(joinPath(buildCacheRoot(substrate.storageDir), cache), substrate.gitEnv);
  }
};

export const disposeWorkspace = async (
  substrate: Substrate,
  frame: WorkspaceDispose,
): Promise<WorkspaceReport> => {
  const { workspaceId } = frame;
  const entry = substrate.registry.held(workspaceId);
  if (entry?.kind === "primary") {
    return {
      _tag: "workspaceReport",
      workspaceId,
      status: "failed",
      message: "a main workspace is never torn down",
    };
  }
  await tearDown(
    substrate.storageDir,
    // The path is built from the id, not read from the entry: a failed
    // provisioning can leave a directory behind with no entry, and this call
    // must still remove it.
    joinPath(substrate.storageDir, "workspaces", workspaceId),
    entry?.checkouts ?? [],
    substrate.gitEnv,
  );
  // With no entry we do not know which caches the workspace used, so prune all
  // of them. This runs after the directories are gone, like the prunes inside
  // `tearDown`.
  if (entry === undefined) await pruneEveryCache(substrate);
  await substrate.registry.update((entries) =>
    entries.filter((held) => held.workspaceId !== workspaceId),
  );
  return { _tag: "workspaceReport", workspaceId, status: "deleted" };
};
