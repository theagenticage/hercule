/**
 * The reads of a machine's Storage section besides the shell's workspaces
 * (spec 17 §Fleet, A machine's page, point 5): what the runner negotiated, and
 * the Threads of the workspaces that are idle. The machine page's loader reads
 * both before the page renders, the Storage section draws them, and the
 * cleanup dialog's button reads the same Threads through `cleanupThreadsQuery`.
 *
 * They live in their own module, not in `queries.ts`, because
 * `@hercule/client-core/cleanup` is not part of the first screen.
 */
import { queryOptions, type QueryKey } from "@tanstack/react-query";
import { queryKeys, type HerculeClient } from "@hercule/client-core";
import { listCleanupCandidates, readCleanupThreads } from "@hercule/client-core/cleanup";
import type { Session, Workspace } from "@hercule/contract";
import { LIVE_KEPT_READ_OPTIONS } from "./queries";

/**
 * Reads the capabilities the runner `runnerId` negotiated with the controller
 * (`runner.read`), or `null` while they are not known. A machine whose list
 * lacks the disk usage capability is too old to measure its storage.
 *
 * The key sits under the runner's own (`["runner", runnerId, ...]`), so a
 * `runner` push that names the machine, or names no runner, reads it again: a
 * runner that updates and says hello again shows at once.
 */
export const negotiatedCapabilitiesQuery = (client: HerculeClient, runnerId: string) =>
  queryOptions({
    queryKey: [...queryKeys.runner(runnerId), "negotiated-capabilities"] as QueryKey,
    queryFn: async (): Promise<readonly string[] | null> =>
      (await client.runner.read({ params: { id: runnerId } })).negotiatedCapabilities,
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Lists the ids of the workspaces of the machine `runnerId` that a cleanup may
 * remove at `now` (`listCleanupCandidates`), sorted. Sorting makes the list a
 * stable part of a query key: it changes only when the set of candidates does.
 */
export const listCleanupCandidateIds = (
  workspaces: readonly Workspace[],
  runnerId: string,
  now: Date,
): readonly string[] =>
  listCleanupCandidates(workspaces, runnerId, now)
    .map((workspace) => workspace.id)
    .toSorted();

/**
 * The Threads read for the idle workspaces of a machine, with the ids of the
 * workspaces they were read for. A workspace of `workspaceIds` that no Thread
 * used has none in `threads`, so the ids are what tells that it was covered.
 */
export interface CleanupThreadsRead {
  readonly workspaceIds: readonly string[];
  readonly threads: readonly Session[];
}

/**
 * Reads the Threads, archived ones included, that were placed in the
 * workspaces `workspaceIds` of the machine `runnerId` (`readCleanupThreads`).
 * Pass the ids `listCleanupCandidateIds` returns.
 *
 * The key holds the runner alone, not the ids. A cleanup removes its
 * workspaces one by one, and a key that held the ids would read the Threads of
 * every workspace left after each removal. The Storage section reads again
 * only when a candidate appears that `coversWorkspaces` says the data lacks.
 * An idle workspace cannot gain or lose a Thread without its last use
 * changing, which takes it out of the set.
 *
 * No push reads this again. The key is outside the `sessions` prefix on
 * purpose, because a `session` push arrives about once a second while agents
 * work. A caller that needs the Threads fresh, such as the cleanup dialog,
 * reads with `staleTime: 0`.
 */
export const cleanupThreadsQuery = (
  client: HerculeClient,
  runnerId: string,
  workspaceIds: readonly string[],
) =>
  queryOptions({
    queryKey: ["cleanup-threads", runnerId] as QueryKey,
    queryFn: async (): Promise<CleanupThreadsRead> => ({
      workspaceIds,
      threads: await readCleanupThreads(client, workspaceIds),
    }),
    ...LIVE_KEPT_READ_OPTIONS,
  });

/** Checks whether `read` holds the Threads of every one of `workspaceIds`. */
export const coversWorkspaces = (
  read: CleanupThreadsRead | undefined,
  workspaceIds: readonly string[],
): boolean => {
  if (read === undefined) return false;
  const covered = new Set(read.workspaceIds);
  return workspaceIds.every((id) => covered.has(id));
};

/** Returns the Threads of `read` that were placed in one of `workspaceIds`. */
export const listThreadsOf = (
  read: CleanupThreadsRead | undefined,
  workspaceIds: readonly string[],
): readonly Session[] => {
  const wanted = new Set(workspaceIds);
  return (read?.threads ?? []).filter(
    (thread) => thread.workspaceId !== null && wanted.has(thread.workspaceId),
  );
};
