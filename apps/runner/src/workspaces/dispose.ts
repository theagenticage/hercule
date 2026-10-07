/**
 * Tears down an ephemeral workspace. The branch the agent worked on stays in
 * the cache, so nothing the agent committed is lost with the directory. A
 * primary is never torn down: it is the long-lived main workspace that
 * sessions share.
 */
import { existsSync, readdirSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { join as joinPath } from "node:path";
import type { WorkspaceDispose, WorkspaceReport } from "@hercule/protocol";
import { buildCacheDir, buildCacheRoot, pruneWorktrees, removeWorktree } from "./git";
import type { RegisteredCheckout } from "./registry";
import type { Substrate } from "./substrate";

/** Removes recorded clean worktrees and then removes only an empty workspace root. */
export const tearDown = async (
  substrate: Substrate,
  root: string,
  checkouts: ReadonlyArray<RegisteredCheckout>,
): Promise<void> => {
  for (const checkout of checkouts) {
    const common =
      checkout.commonDirectory ?? buildCacheDir(substrate.storageDir, checkout.resourceId);
    await substrate.coordinateRepository(`git:${realpathSync(common)}`, async () => {
      if (existsSync(checkout.path)) {
        const result = await removeWorktree(common, checkout.path, substrate.gitEnv);
        if (!result.ok)
          throw new Error(
            `Git refused to remove the checkout. Preserve its files and inspect it before disposal: ${result.stderr}`,
          );
      }
      await pruneWorktrees(common, substrate.gitEnv);
    });
  }
  if (existsSync(root)) {
    try {
      rmdirSync(root);
    } catch (error) {
      throw new Error(
        "Workspace files remain outside its recorded checkouts. Inspect and preserve those files before disposal.",
        { cause: error },
      );
    }
  }
};

/** Returns the directory that holds one directory of step result files per workspace. */
export const buildStepResultsRoot = (storageDir: string): string =>
  joinPath(storageDir, "step-results");

/**
 * Returns the directory that holds the result files of one workspace's
 * workspace steps. It sits outside every checkout, so a step's result can
 * never be committed, and a checkout's owner never sees it.
 */
export const buildStepResultsDir = (storageDir: string, workspaceId: string): string =>
  joinPath(buildStepResultsRoot(storageDir), workspaceId);

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
    const common = realpathSync(joinPath(buildCacheRoot(substrate.storageDir), cache));
    await substrate.coordinateRepository(`git:${common}`, () =>
      pruneWorktrees(common, substrate.gitEnv),
    );
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
  try {
    await tearDown(
      substrate,
      entry?.root ?? joinPath(substrate.storageDir, "workspaces", workspaceId),
      entry?.checkouts ?? [],
    );
  } catch (error) {
    return {
      _tag: "workspaceReport",
      workspaceId,
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  // With no entry we do not know which caches the workspace used, so prune all
  // of them. This runs after the directories are gone, like the prunes inside
  // `tearDown`.
  if (entry === undefined) await pruneEveryCache(substrate);
  // The controller disposes a workspace only once it owes none of its steps,
  // so no step of this workspace will be asked about again.
  rmSync(buildStepResultsDir(substrate.storageDir, workspaceId), { recursive: true, force: true });
  await substrate.registry.update((entries) =>
    entries.filter((held) => held.workspaceId !== workspaceId),
  );
  return { _tag: "workspaceReport", workspaceId, status: "deleted" };
};
