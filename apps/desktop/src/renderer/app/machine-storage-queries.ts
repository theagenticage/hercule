/**
 * The reads of a machine's Storage section besides the shell's workspaces
 * (spec 17 §Fleet, A machine's page, point 5): what the runner negotiated, and
 * the Threads of the workspaces that are idle. The machine page's loader reads
 * both before the page renders (`loadMachineStorage`), the Storage section
 * draws them (`useIdleWorkspaceThreads`), and the cleanup dialog's button
 * writes the Threads it reads into the same entry (`readThreadsForDialog`).
 *
 * They live in their own module, not in `queries.ts`, because
 * `@hercule/client-core/cleanup` is not part of the first screen.
 */
import { useEffect } from "react";
import {
  queryOptions,
  useQuery,
  useSuspenseQuery,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { queryKeys, type HerculeClient } from "@hercule/client-core";
import { listCleanupCandidates } from "@hercule/client-core/cleanup";
import { computeDayStart } from "@hercule/client-core/list-time";
import { canMeasureStorage } from "@hercule/client-core/machine-storage";
import { readWorkspaceThreads } from "@hercule/client-core/workspace-threads";
import type { Session, Workspace } from "@hercule/contract";
import { LIVE_KEPT_READ_OPTIONS, workspacesQuery } from "./queries";

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
 * Decides the time the Storage section counts idleness, the forecast and the
 * day of the last sweep at. It is the time the Fleet page's hour points were
 * read (`hourPointsReadAt`, Unix ms), so the forecast here counts its days
 * from the same time the machine's card does. When the page's day has begun
 * since that read, as it has for a machine that has been away for days or just
 * after midnight, it is the start of the day (`today`) instead, so "yesterday"
 * and the idle weeks are never counted from the past.
 *
 * The time can lag the clock by up to an hour (the hour points are read about
 * once an hour). The cleanup dialog does not use it: the Clean up… button
 * decides which workspaces are idle at the moment it is pressed. A workspace
 * that turned idle within the last hour can therefore be in the dialog before
 * it is in the page's list of the largest idle workspaces. Both are kept so
 * that no timer has to run.
 */
export const decideStorageNow = (hourPointsReadAt: number, today: Date): Date =>
  new Date(Math.max(hourPointsReadAt, today.getTime()));

/**
 * Lists the ids of the workspaces of the machine `runnerId` that a cleanup may
 * remove at `now` (`listCleanupCandidates`), sorted. A list in a fixed order
 * stays equal when the shell's workspaces arrive in another order, so the
 * `select` that returns it keeps its reference and draws nothing again.
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
interface IdleWorkspaceThreadsRead {
  readonly workspaceIds: readonly string[];
  readonly threads: readonly Session[];
}

/**
 * The entry of the Threads of the idle workspaces of the machine `runnerId`.
 * One entry per machine, whatever the set of workspaces. A cleanup removes its
 * workspaces one by one, and a key that held their ids would read the Threads
 * of every workspace left after each removal. An idle workspace cannot gain
 * or lose a Thread without its last use changing, which takes it out of the
 * set, so an entry stays right for every workspace it covers.
 *
 * It is outside the `sessions` prefix on purpose: a `session` push arrives
 * about once a second while agents work, and no push reads this again.
 */
const idleWorkspaceThreadsKey = (runnerId: string): QueryKey => [
  "idle-workspace-threads",
  runnerId,
];

/**
 * Reads the Threads, archived ones included, that were placed in the
 * workspaces `workspaceIds` of the machine `runnerId`
 * (`readWorkspaceThreads`). The read closes over `workspaceIds` while the key
 * does not hold them, so a reader that needs other ids than the ones the entry
 * covers must read again (`useIdleWorkspaceThreads` does).
 */
const idleWorkspaceThreadsQuery = (
  client: HerculeClient,
  runnerId: string,
  workspaceIds: readonly string[],
) =>
  queryOptions({
    queryKey: idleWorkspaceThreadsKey(runnerId),
    queryFn: async (): Promise<IdleWorkspaceThreadsRead> => ({
      workspaceIds,
      threads: await readWorkspaceThreads(client, workspaceIds),
    }),
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Writes `threads`, the Threads placed in the idle workspaces `workspaceIds`
 * of the machine `runnerId`, to the entry the Storage section reads.
 */
export const writeIdleWorkspaceThreads = (
  queryClient: QueryClient,
  runnerId: string,
  workspaceIds: readonly string[],
  threads: readonly Session[],
): void => {
  queryClient.setQueryData<IdleWorkspaceThreadsRead>(idleWorkspaceThreadsKey(runnerId), {
    workspaceIds,
    threads,
  });
};

/** Checks whether `read` holds the Threads of every one of `workspaceIds`. */
const coversWorkspaces = (
  read: IdleWorkspaceThreadsRead | undefined,
  workspaceIds: readonly string[],
): boolean => {
  if (read === undefined) return false;
  const covered = new Set(read.workspaceIds);
  return workspaceIds.every((id) => covered.has(id));
};

/** What `useIdleWorkspaceThreads` returns. */
export interface IdleWorkspaceThreads {
  /** The Threads placed in the machine's idle workspaces. Empty until they are known. */
  readonly threads: readonly Session[];
  /**
   * Whether `threads` holds the Threads of every idle workspace. While it is
   * false, a list built from `threads` could miss a workspace or read as empty.
   */
  readonly isKnown: boolean;
  /** Why the read failed, or `null` when it did not. */
  readonly error: unknown;
  /** Reads again after a failure. */
  readonly retry: () => void;
}

/**
 * Reads the Threads of the idle workspaces of the machine `runnerId` at `now`,
 * the shell's workspaces being the source of which are idle. Reads nothing when
 * `isMeasured` is false (the runner cannot measure storage) or no workspace is
 * idle.
 *
 * - The first read is the loader's (`loadMachineStorage`). This hook reads
 *   again once when an idle workspace appears that the data does not cover.
 *   A workspace that leaves the set, for example one a cleanup removes, reads
 *   nothing: its Threads are filtered out of the data.
 * - A failed read waits for `retry`.
 * - `isKnown` is false while the data covers only an older set of workspaces,
 *   or the read failed.
 */
export const useIdleWorkspaceThreads = (
  client: HerculeClient,
  runnerId: string,
  now: Date,
  isMeasured: boolean,
): IdleWorkspaceThreads => {
  const { data: idleIds } = useSuspenseQuery({
    ...workspacesQuery(client),
    select: (workspaces) => listCleanupCandidateIds(workspaces, runnerId, now),
  });
  const hasIdle = idleIds.length > 0;
  const read = useQuery({
    ...idleWorkspaceThreadsQuery(client, runnerId, idleIds),
    enabled: isMeasured && hasIdle,
  });
  const isCovered = coversWorkspaces(read.data, idleIds);
  // The entry is kept for good, so a new idle workspace does not read by
  // itself: this does, once, when the data lacks it.
  const { refetch } = read;
  const mustReadAgain =
    isMeasured &&
    hasIdle &&
    !isCovered &&
    read.data !== undefined &&
    !read.isFetching &&
    !read.isError;
  useEffect(() => {
    if (mustReadAgain) void refetch();
  }, [mustReadAgain, refetch]);

  const wanted = new Set(idleIds);
  return {
    threads: (read.data?.threads ?? []).filter(
      (thread) => thread.workspaceId !== null && wanted.has(thread.workspaceId),
    ),
    isKnown: !hasIdle || (isCovered && !read.isError),
    error: read.isError ? read.error : null,
    retry: () => void refetch(),
  };
};

/**
 * Reads afresh the Threads placed in the workspaces `workspaceIds` of the
 * machine `runnerId` and returns them. Fails when the read fails.
 *
 * The read is the caller's own, not a share of one that is already running
 * under the page's key: that one may have been started for other workspaces,
 * and a dialog must list exactly the Threads of the workspaces it offers.
 * The result is then written to the page's entry, so the Storage section
 * draws from it.
 */
export const readThreadsForDialog = async (
  queryClient: QueryClient,
  client: HerculeClient,
  runnerId: string,
  workspaceIds: readonly string[],
): Promise<readonly Session[]> => {
  const threads = await readWorkspaceThreads(client, workspaceIds);
  writeIdleWorkspaceThreads(queryClient, runnerId, workspaceIds, threads);
  return threads;
};

/**
 * Reads what the Storage section of the machine `runnerId` draws, before the
 * page renders: the runner's negotiated capabilities, the shell's workspaces,
 * and, when the runner can measure storage, the Threads of the idle
 * workspaces. `hours` is the read of the Fleet page's hour points, which the
 * caller starts (they live beside the Fleet routes, where this module cannot
 * import them); `timezone` is the zone of the page's days (see
 * `decideStorageNow`).
 *
 * The Threads are read last and with `prefetchQuery`, which never fails: the
 * section draws a failed read as a line with a Retry.
 */
export const loadMachineStorage = async (
  queryClient: QueryClient,
  client: HerculeClient,
  runnerId: string,
  timezone: string,
  hours: Promise<{ readonly readAt: number }>,
): Promise<void> => {
  const [capabilities, { readAt }, workspaces] = await Promise.all([
    queryClient.ensureQueryData(negotiatedCapabilitiesQuery(client, runnerId)),
    hours,
    queryClient.ensureQueryData(workspacesQuery(client)),
  ]);
  if (!canMeasureStorage(capabilities)) return;
  const now = new Date();
  const today = computeDayStart(now, timezone) ?? now;
  const idleIds = listCleanupCandidateIds(workspaces, runnerId, decideStorageNow(readAt, today));
  if (idleIds.length === 0) return;
  await queryClient.prefetchQuery(idleWorkspaceThreadsQuery(client, runnerId, idleIds));
};
