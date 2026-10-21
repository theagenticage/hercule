import type { TrackingState } from "@hercule/client-core";
import type { MarkState } from "../../marks";

/** The mark before the state's word on its heading, as the Tracking drawing gives it. */
export const TRACKING_STATE_MARKS: Readonly<Record<TrackingState, MarkState>> = {
  "needs-you": "waiting",
  failed: "failed",
  finished: "done",
  working: "working",
  stopped: "paused",
};

/**
 * Returns the words of "N wait on you", Tracking's count of rows that wait on
 * the user, or `null` for none: the head then says nothing about waiting.
 */
export const describeWaitingOnYou = (count: number): string | null =>
  count === 0 ? null : `${String(count)} ${count === 1 ? "waits" : "wait"} on you`;
