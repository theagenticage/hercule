import { useEffect, type JSX, type ReactNode } from "react";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { readErrorMessage } from "@hercule/client-core";
import { canMeasureStorage, describeMachineStorage } from "@hercule/client-core/machine-storage";
import { FLEET_HOUR_METRICS_SCOPE } from "@hercule/client-core/metrics-history";
import type { Runner } from "@hercule/contract";
import {
  cleanupThreadsQuery,
  coversWorkspaces,
  listCleanupCandidateIds,
  filterThreadsToWorkspaces,
  negotiatedCapabilitiesQuery,
} from "../../../../app/machine-storage-queries";
import { machineRecentActivityQuery, workspacesQuery } from "../../../../app/queries";
import { MachineActivityNote } from "../../../../screens/fleet/machine-activity-note";
import { MachineStoragePanel } from "../../../../screens/fleet/machine-storage";
import { decideStorageNow } from "./-machine-storage-reads";
import { runnerMetricsQuery } from "./-runner-metrics";

/**
 * Renders the Storage section of the machine `runner`'s page (spec 17 §Fleet,
 * A machine's page, point 5): the disk as one bar in parts, the line on
 * automatic cleanup, and the largest idle workspaces. `cleanUp` is the button
 * that opens the cleanup dialog. The section draws it at the right of the
 * head of "Largest idle workspaces". `timezone` is the zone the days are
 * worded in, and `today` the start of the current day in it (`useFleetToday`).
 *
 * - The workspaces are the shell's own read, which the `workspace` push keeps
 *   current. The section is built in that read's `select`, so a push that
 *   changes nothing the section draws re-renders nothing.
 * - The Threads of the idle workspaces tell which of them a Thread used
 *   (`cleanupThreadsQuery`). They are read when the section first draws, and
 *   again only when an idle workspace appears that the data does not cover. A
 *   workspace that leaves the set, for example one a cleanup removes, reads
 *   nothing: its Threads are filtered out of the data. A runner that cannot
 *   measure storage reads none. While the Threads are unread, or the read
 *   failed, the list shows neither rows nor "No idle workspaces."; a failed
 *   read shows a line with a Retry.
 * - The forecast in the head comes from the Fleet page's hour points, read
 *   again at most once an hour (`useRunnerMetricsLive`). The last sweep comes
 *   from the first page of the machine's audit log, which Recent reads.
 * - Nothing polls and no timer runs.
 */
export function MachineStorage({
  id,
  runner,
  timezone,
  today,
  cleanUp,
}: {
  readonly id: string;
  readonly runner: Runner;
  readonly timezone: string;
  readonly today: Date;
  readonly cleanUp: ReactNode;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const { data: capabilities } = useSuspenseQuery(negotiatedCapabilitiesQuery(client, runner.id));
  const { data: hours } = useSuspenseQuery(runnerMetricsQuery(client, FLEET_HOUR_METRICS_SCOPE));
  const recent = useQuery(machineRecentActivityQuery(client, runner.id));
  const now = decideStorageNow(hours.readAt, today);
  const isMeasured = canMeasureStorage(capabilities);

  const { data: candidateIds } = useSuspenseQuery({
    ...workspacesQuery(client),
    select: (workspaces) => listCleanupCandidateIds(workspaces, runner.id, now),
  });
  const threads = useQuery({
    ...cleanupThreadsQuery(client, runner.id, candidateIds),
    enabled: isMeasured && candidateIds.length > 0,
  });
  // The query is kept for good, so a new candidate does not read by itself:
  // this does, once, when the data lacks it. A failed read waits for Retry.
  const { refetch: readThreadsAgain } = threads;
  const mustReadAgain =
    isMeasured &&
    candidateIds.length > 0 &&
    !coversWorkspaces(threads.data, candidateIds) &&
    threads.data !== undefined &&
    !threads.isFetching &&
    !threads.isError;
  useEffect(() => {
    if (mustReadAgain) void readThreadsAgain();
  }, [mustReadAgain, readThreadsAgain]);
  // Data that covers only an older set of workspaces is not known yet: the
  // list would miss the Threads of the new ones and could read as empty.
  const areThreadsKnown =
    candidateIds.length === 0 || (coversWorkspaces(threads.data, candidateIds) && !threads.isError);

  const { data: storage } = useSuspenseQuery({
    ...workspacesQuery(client),
    select: (workspaces) =>
      describeMachineStorage({
        runner,
        negotiatedCapabilities: capabilities,
        workspaces,
        threads: filterThreadsToWorkspaces(threads.data, candidateIds),
        hourPoints: hours.points.filter((point) => point.runnerId === runner.id),
        events: recent.data?.items ?? [],
        timezone,
        now,
      }),
  });

  return (
    <MachineStoragePanel
      id={id}
      storage={storage}
      cleanUp={cleanUp}
      isLargestIdleKnown={areThreadsKnown}
      readFailure={
        threads.isError ? (
          <MachineActivityNote onRetry={() => void threads.refetch()}>
            {`Couldn't read the idle workspaces. ${readErrorMessage(threads.error)}`}
          </MachineActivityNote>
        ) : null
      }
    />
  );
}
