/**
 * Tearing an ephemeral workspace down. The branch the agent worked on stays in
 * the cache, so nothing it committed is thrown away with the directory, and a
 * primary is refused outright: that directory is the user's own.
 */
import { readdirSync, rmSync } from "node:fs";
import { join as joinPath } from "node:path";
import type { WorkspaceDispose, WorkspaceReport } from "@hydra/protocol";
import { cacheDirOf, cacheRootIn, pruneWorktrees, removeWorktree } from "./git";
import type { Substrate } from "./substrate";

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
  for (const one of entry?.checkouts ?? []) {
    await removeWorktree(
      cacheDirOf(substrate.storageDir, one.resourceId),
      one.path,
      substrate.gitEnv,
    );
  }
  // Derived from the id rather than from the entry: a workspace whose making
  // failed left a directory behind and no entry, and this is what removes it.
  rmSync(joinPath(substrate.storageDir, "workspaces", workspaceId), {
    recursive: true,
    force: true,
  });
  // After the directories are gone, so nothing is left registered to one.
  if (entry === undefined) await pruneEveryCache(substrate);
  else {
    for (const one of entry.checkouts) {
      await pruneWorktrees(cacheDirOf(substrate.storageDir, one.resourceId), substrate.gitEnv);
    }
  }
  await substrate.registry.update((entries) =>
    entries.filter((held) => held.workspaceId !== workspaceId),
  );
  return { _tag: "workspaceReport", workspaceId, status: "deleted" };
};
