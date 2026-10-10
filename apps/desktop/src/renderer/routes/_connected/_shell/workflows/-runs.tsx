import { useEffect, useRef, type JSX, type RefObject } from "react";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import type { Trigger, WorkflowDefinition } from "@hercule/contract";
import {
  buildTimelineBars,
  computeTimelineReadRange,
  type TimelineAxis,
  type TimelineDay,
} from "../../../../screens/workflows/run-timeline";
import { TimelineBoard } from "../../../../screens/workflows/run-timeline-board";
import { RunTable } from "../../../../screens/workflows/workflow-detail";
import { buildRunRow } from "../../../../screens/workflows/workflow-detail-rows";
import {
  waitingRunSessionsQuery,
  workflowRunningRunsQuery,
  workflowRunsBetweenQuery,
  workflowRunsQuery,
} from "../../../../screens/workflows/workflow-queries";

/**
 * Renders the Runs tab's list, newest first. It reads the next page of runs
 * when the end of the table scrolls into view. Picking a run calls
 * `onOpenRun`.
 */
export function RunsPanel({
  client,
  workflowId,
  definition,
  onOpenRun,
  timezone,
  now,
}: {
  readonly client: HerculeClient;
  readonly workflowId: string;
  readonly definition: WorkflowDefinition;
  readonly onOpenRun: (runId: string) => void;
  readonly timezone: string;
  readonly now: Date;
}): JSX.Element {
  const runs = useSuspenseInfiniteQuery(workflowRunsQuery(client, workflowId));
  const waitingSessions = useSuspenseQuery(waitingRunSessionsQuery()).data;
  const endRef = useRef<HTMLDivElement>(null);
  useReadingNextPage(endRef, runs.hasNextPage && !runs.isFetchingNextPage, runs.fetchNextPage);

  const rows = runs.data.pages
    .flatMap((page) => page.items)
    .map((run) => buildRunRow(run, definition, waitingSessions, timezone, now));
  return <RunTable rows={rows} onOpenRun={onOpenRun} endRef={endRef} />;
}

/**
 * Renders the Runs tab's timeline of `day`: the runs that ran on it, and the
 * fires still to come when it is today. `axis` is the day's axis, which the
 * page draws in its sticky band. Picking a run's bar calls `onOpenRun`.
 *
 * It reads the runs created from the day before up to the day's end, and
 * every run still running, because a run that waits on the user can run on
 * days long after the one it was created on.
 */
export function RunsTimeline({
  client,
  workflowId,
  definition,
  enabled,
  triggers,
  day,
  axis,
  onOpenRun,
  timezone,
  now,
}: {
  readonly client: HerculeClient;
  readonly workflowId: string;
  readonly definition: WorkflowDefinition;
  readonly enabled: boolean;
  readonly triggers: ReadonlyArray<Trigger>;
  readonly day: TimelineDay;
  readonly axis: TimelineAxis;
  readonly onOpenRun: (runId: string) => void;
  readonly timezone: string;
  readonly now: Date;
}): JSX.Element {
  const { since, until } = computeTimelineReadRange(day, timezone);
  const dayRuns = useSuspenseQuery(workflowRunsBetweenQuery(client, workflowId, since, until)).data;
  const runningRuns = useSuspenseQuery(workflowRunningRunsQuery(client, workflowId)).data;
  const waitingSessions = useSuspenseQuery(waitingRunSessionsQuery()).data;

  const { bars, trackCount, fires } = buildTimelineBars(
    { runs: [...dayRuns, ...runningRuns], definition, enabled, waitingSessions, triggers },
    day,
    timezone,
    now,
  );
  const isToday = axis.now !== undefined;
  return (
    <TimelineBoard
      label={`Runs, ${axis.dayText}`}
      axis={axis}
      bars={bars}
      trackCount={trackCount}
      fires={fires}
      onOpenRun={onOpenRun}
      emptyText={isToday ? "No runs today" : "No runs this day"}
    />
  );
}

/**
 * Calls `readNextPage` whenever `endRef`'s element comes within a screen of
 * view while `canRead` is true.
 */
function useReadingNextPage(
  endRef: RefObject<HTMLDivElement | null>,
  canRead: boolean,
  readNextPage: () => unknown,
): void {
  useEffect(() => {
    const end = endRef.current;
    if (!canRead || end === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void readNextPage();
      },
      { rootMargin: "100% 0px" },
    );
    observer.observe(end);
    return () => observer.disconnect();
  }, [endRef, canRead, readNextPage]);
}
