/**
 * Reads Tracking's rows and the To do count that takes them in. Every place
 * that shows either reads it here, so they always agree.
 */
import { keepPreviousData, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { RunSummary } from "@hercule/contract";
import {
  buildTrackingRows,
  countToDo,
  countWaitingTrackingRows,
  type TrackingRow,
} from "@hercule/client-core";
import { signalsToDoQuery, trackedRunsQuery, trackedTasksQuery } from "./queries";

/** The runs while the runs of a changed set of Tasks are read: none. */
const NO_RUNS: ReadonlyArray<RunSummary> = [];

/**
 * Returns Tracking's rows, in Tracking's order, as `buildTrackingRows` builds
 * them from the tracked Tasks and their runs.
 *
 * The shell's loader reads both, so neither waits in practice. When a Task
 * joins or leaves Tracking, its runs are read under a new key. Until that
 * read answers, the rows are built from the previous read of the runs, so
 * the rows and the count do not blink out: a Task that just joined has no
 * row yet, and one that left has none any more.
 */
export function useTrackingRows(): ReadonlyArray<TrackingRow> {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const tasks = useSuspenseQuery(trackedTasksQuery(client)).data;
  const runs =
    useQuery({
      ...trackedRunsQuery(
        client,
        tasks.map((task) => task.id),
      ),
      placeholderData: keepPreviousData,
    }).data ?? NO_RUNS;
  return buildTrackingRows(tasks, runs);
}

/**
 * Returns the To do count: the open signals on To do, and the rows of
 * Tracking that wait on the user (`countToDoWithTracking`). The Hercule
 * segment, Intake's row, the All tab and the view switcher all show it.
 */
export function useToDoCount(): number {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const signalCount = useSuspenseQuery({
    ...signalsToDoQuery(client),
    select: countToDo,
  }).data;
  return signalCount + countWaitingTrackingRows(useTrackingRows());
}
