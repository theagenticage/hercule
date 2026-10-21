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
  matchYourWork,
  type TrackingRead,
  type TrackingRow,
  type YourWork,
} from "@hercule/client-core";
import type { Signal, SignalYourWork } from "@hercule/contract";
import { signalsToDoQuery, trackingQuery, yourWorkQuery } from "./queries";
import { useWaitingRunSessions } from "./waiting";

// The selects below capture nothing and live at module level. Query keeps a
// selection only while the select function is the same one, so a function
// made in render would run again on every render. What a select returns is
// kept while it equals the last one, so a read that changes none of the parts
// a caller uses draws nothing again.
const selectTrackingTasks = (read: TrackingRead) => read.tasks;
const selectYourWorkTasks = (read: SignalYourWork) => read.tasks;

/**
 * Returns Your work: for each To do signal, the open Tasks it is about, as
 * `matchYourWork` matches the Tasks the controller named to the cached To do
 * list. The shell's loader reads both, so it never waits in practice. Each
 * caller builds its own map, which is cheap: one pass over the Tasks and the
 * signals.
 *
 * The signals are selected from To do: only those a Task names. A change to
 * any other signal, or a new one, leaves the selection as it was, so it draws
 * nothing again. A signal the user moves off To do leaves the selection at
 * once, and with it Your work, before the controller's answer is read again.
 * The map keeps its identity until a signal Your work names or a Task changes.
 */
export function useYourWork(): YourWork {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const tasks = useSuspenseQuery({ ...yourWorkQuery(client), select: selectYourWorkTasks }).data;
  // Made again only when the Tasks change, because Query keeps a selection
  // only while the select function is the same one.
  const selectNamedSignals = useMemo(() => {
    const namedIds = new Set(tasks.flatMap((task) => task.signalIds));
    return (signals: ReadonlyArray<Signal>) => signals.filter(({ id }) => namedIds.has(id));
  }, [tasks]);
  const signals = useSuspenseQuery({
    ...signalsToDoQuery(client),
    select: selectNamedSignals,
  }).data;
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
