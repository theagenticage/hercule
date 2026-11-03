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
import { DISK_USAGE_CAPABILITY, type Workspace } from "@hercule/contract";
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
 * Checks whether the runner with these `capabilities` can measure the disk
 * usage of its workspaces. Capabilities that are not known yet count as yes:
 * the section then draws what it has, and a runner that turns out to be too
 * old shows its line once they arrive.
 */
export const canMeasureStorage = (capabilities: readonly string[] | null): boolean =>
  capabilities === null || capabilities.includes(DISK_USAGE_CAPABILITY);

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
 * Reads the Threads, archived ones included, that were placed in the
 * workspaces `workspaceIds` of the machine `runnerId` (`readCleanupThreads`).
 * Pass the ids `listCleanupCandidateIds` returns: the key holds them, so the
 * Threads are read again only when the set of candidates changes. An idle
 * workspace cannot gain or lose a Thread without its last use changing, which
 * takes it out of the set.
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
    queryKey: ["cleanup-threads", runnerId, workspaceIds] as QueryKey,
    queryFn: () => readCleanupThreads(client, workspaceIds),
    ...LIVE_KEPT_READ_OPTIONS,
  });
