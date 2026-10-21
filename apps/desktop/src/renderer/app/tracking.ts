/**
 * Reads Tracking's rows, Your work, and the To do count that takes them in.
 * Every place that shows any of them reads it here, so they always agree.
 */
import { useMemo } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  buildTrackingRows,
  countToDo,
  countWaitingTrackingRows,
  listSignalsWithThreadRef,
  matchYourWork,
  type TrackingRead,
  type TrackingRow,
  type YourWork,
  type YourWorkRead,
} from "@hercule/client-core";
import { signalsToDoQuery, trackingQuery, yourWorkQuery } from "./queries";
import { useWaitingRunSessions } from "./waiting";

// The selects below capture nothing and live at module level. Query keeps a
// selection only while the select function is the same one, so a function
// made in render would run again on every render. What a select returns is
// kept while it equals the last one, so a read that changes none of the parts
// a caller uses draws nothing again.
const selectTrackingTasks = (read: TrackingRead) => read.tasks;
const selectYourWorkTasks = (read: YourWorkRead) => read.tasks;

/**
 * Returns Your work: for each To do signal, the open Tasks it is about, as
 * `matchYourWork` works them out from the signals with a thread ref and the
 * Tasks the last read of Your work holds. The shell's loader reads both, so it
 * never waits in practice. Each caller builds its own map, which costs well
 * under a millisecond at the largest sizes (200 signals, 50 Tasks of 200
 * provenance entries each). The map keeps its identity until a signal with a
 * thread ref or a Task changes.
 */
export function useYourWork(): YourWork {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const signals = useSuspenseQuery({
    ...signalsToDoQuery(client),
    select: listSignalsWithThreadRef,
  }).data;
  const tasks = useSuspenseQuery({ ...yourWorkQuery(client), select: selectYourWorkTasks }).data;
  return useMemo(() => matchYourWork(signals, tasks), [signals, tasks]);
}

/**
 * Returns Tracking's rows, in Tracking's order, built from the Tasks of the
 * last read, the Requests of the live runs' sessions and the signals Your work
 * names (`buildTrackingRows`). The shell's loader reads all of them, so they
 * never wait in practice. Each caller builds its own rows. The array keeps its
 * identity until the Tasks, the Requests or Your work change.
 */
export function useTrackingRows(): ReadonlyArray<TrackingRow> {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const tasks = useSuspenseQuery({ ...trackingQuery(client), select: selectTrackingTasks }).data;
  const requests = useWaitingRunSessions();
  const yourWork = useYourWork();
  return useMemo(() => buildTrackingRows(tasks, requests, yourWork), [tasks, requests, yourWork]);
}

/**
 * Returns the To do count: the open signals on To do, and the rows of
 * Tracking that wait on the user. The Hercule segment, Intake's row, the All
 * tab and the view switcher all show it. The count of signals is selected, so
 * a change to a signal that leaves the count as it was draws nothing again.
 */
export function useToDoCount(): number {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const signalCount = useSuspenseQuery({
    ...signalsToDoQuery(client),
    select: countToDo,
  }).data;
  return signalCount + countWaitingTrackingRows(useTrackingRows());
}
