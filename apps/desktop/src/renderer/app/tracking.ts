/**
 * Reads Tracking's rows and the To do count that takes them in. Every place
 * that shows either reads it here, so they always agree.
 */
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  countToDo,
  countWaitingTrackingRows,
  type TrackingRow,
  type TrackingSnapshot,
} from "@hercule/client-core";
import { signalsToDoQuery, trackingQuery } from "./queries";

/** Returns the rows of a snapshot. Its identity is the query's, so the selection keeps its result. */
const selectRows = (snapshot: TrackingSnapshot): ReadonlyArray<TrackingRow> => snapshot.rows;

/**
 * Returns Tracking as last read: its rows in Tracking's order, and the ids of
 * the runs they were worked out from. The shell's loader reads it, so it
 * never waits in practice.
 */
export function useTrackingSnapshot(): TrackingSnapshot {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  return useSuspenseQuery(trackingQuery(client)).data;
}

/**
 * Returns Tracking's rows, in Tracking's order. The array is built once, by
 * the read, so every caller gets the same array until a read changes a row.
 */
export function useTrackingRows(): ReadonlyArray<TrackingRow> {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  return useSuspenseQuery({ ...trackingQuery(client), select: selectRows }).data;
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
