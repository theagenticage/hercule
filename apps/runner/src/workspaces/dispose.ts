/**
 * Tearing an ephemeral workspace down. The branch the agent worked on stays in
 * the cache, so nothing it committed is thrown away with the directory, and a
 * primary is refused outright: that directory is the user's own.
 */
import { readdirSync, rmSync } from "node:fs";
import { join as joinPath } from "node:path";
import type { WorkspaceDispose, WorkspaceReport } from "@hydra/protocol";
import { cacheDirOf, cacheRootIn, pruneWorktrees, removeWorktree } from "./git";
import type { GitEnv } from "./git";
import type { RegisteredCheckout } from "./registry";
import type { Substrate } from "./substrate";

/**
 * Taking a workspace off the disk: the worktrees first, then the directory, and
 * only then the caches' belief that those directories are theirs. That order is
 * the whole of it - a prune that ran before the directories were gone would
 * leave registered whatever was removed after it - which is why the workspace
 * that is being torn down and the one whose making failed share this rather
 * than each spelling the order out.
 */
export const tearDown = async (
  storageDir: string,
  root: string,
  checkouts: ReadonlyArray<RegisteredCheckout>,
  env: GitEnv,
): Promise<void> => {
  for (const one of checkouts) {
    await removeWorktree(cacheDirOf(storageDir, one.resourceId), one.path, env);
  }
  rmSync(root, { recursive: true, force: true });
  for (const one of checkouts) {
    await pruneWorktrees(cacheDirOf(storageDir, one.resourceId), env);
  }
};

/**
 * Every cache on this machine, pruned. What this is for is the workspace whose
 * making failed: it left a worktree registered in a cache and no entry saying
 * which, and a cache that believes in a directory that is gone refuses to make
 * another one there.
 */
const pruneEveryCache = async (substrate: Substrate): Promise<void> => {
  let caches: ReadonlyArray<string>;
  try {
    caches = readdirSync(cacheRootIn(substrate.storageDir));
  } catch {
    return;
  }
  for (const cache of caches) {
    await pruneWorktrees(joinPath(cacheRootIn(substrate.storageDir), cache), substrate.gitEnv);
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
      message: "a primary is never torn down",
    };
  }
  await tearDown(
    substrate.storageDir,
    // Derived from the id rather than from the entry: a workspace whose making
    // failed left a directory behind and no entry, and this is what removes it.
    joinPath(substrate.storageDir, "workspaces", workspaceId),
    entry?.checkouts ?? [],
    substrate.gitEnv,
  );
  // With no entry there is no cache to name, so every one of them is asked -
  // after the directories are gone, like the prunes inside the teardown.
  if (entry === undefined) await pruneEveryCache(substrate);
  await substrate.registry.update((entries) =>
    entries.filter((held) => held.workspaceId !== workspaceId),
  );
  return { _tag: "workspaceReport", workspaceId, status: "deleted" };
};
