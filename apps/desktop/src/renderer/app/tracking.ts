/**
 * Reads Tracking's rows and the To do count that takes them in. Every place
 * that shows either reads it here, so they always agree.
 */
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { countToDo, countWaitingTrackingRows, type TrackingRow } from "@hercule/client-core";
import { signalsToDoQuery, trackingQuery } from "./queries";

/**
 * Returns Tracking's rows, in Tracking's order. The shell's loader reads
 * them, so they never wait in practice. The array is built once, by the read,
 * so every caller gets the same array until a read changes a row.
 */
export function useTrackingRows(): ReadonlyArray<TrackingRow> {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  // Only the rows are selected, so a read that changes none of them draws nothing again.
  return useSuspenseQuery({
    ...trackingQuery(client),
    select: (read) => read.rows,
  }).data;
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
