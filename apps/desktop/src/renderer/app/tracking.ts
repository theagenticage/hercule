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
 * Returns the Tasks Tracking follows, as the last read gives them. The array
 * keeps its identity until a read changes a Task.
 */
function useTrackingTasks() {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  return useSuspenseQuery({ ...trackingQuery(client), select: selectTrackingTasks }).data;
}

/**
 * Returns the To do signals that have a thread ref, which are the only ones
 * that can be Your work. It keeps its identity until one of them changes, so
 * a signal without a thread ref changes nothing that reads it.
 */
function useSignalsWithThreadRef() {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  return useSuspenseQuery({ ...signalsToDoQuery(client), select: listSignalsWithThreadRef }).data;
}

/**
 * Returns Your work: for each To do signal, the open Tasks it is about, as
 * `matchYourWork` works them out from the signals and the Tasks the last read
 * of Your work holds. The shell's loader reads both, so it never waits in
 * practice. The map keeps its identity until a signal or a Task it is built
 * from changes.
 */
export function useYourWork(): YourWork {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const signals = useSignalsWithThreadRef();
  const tasks = useSuspenseQuery({ ...yourWorkQuery(client), select: selectYourWorkTasks }).data;
  // A manual `useMemo`, because the map's identity is what keeps the rows from
  // being built again, and the React Compiler may skip memoizing a value that a
  // plain function builds from other values (it assumes the function can change them).
  return useMemo(() => matchYourWork(signals, tasks), [signals, tasks]);
}

/**
 * Returns Tracking's rows, in Tracking's order, built from the Tasks of the
 * last read, the Requests of the live runs' sessions and the signals Your work
 * names (`buildTrackingRows`). The shell's loader reads all of them, so they
 * never wait in practice. Each caller builds its own array, which is cheap and
 * happens again only when one of those changes. The array keeps its identity
 * until then.
 */
export function useTrackingRows(): ReadonlyArray<TrackingRow> {
  const tasks = useTrackingTasks();
  const requests = useWaitingRunSessions();
  const signals = useSignalsWithThreadRef();
  const yourWork = useYourWork();
  return useMemo(
    () => buildTrackingRows(tasks, { requests, signals, yourWork }),
    [tasks, requests, signals, yourWork],
  );
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
