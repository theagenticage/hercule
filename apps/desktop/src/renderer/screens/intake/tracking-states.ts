import type { Pose, TrackingState } from "@hercule/client-core";
import type { MarkState } from "../../marks";

/** How Tracking draws one state: its word, the pose of the face on its rows, and its state mark. */
export interface TrackingStateLook {
  /** The word on the state's heading, such as "Finished". */
  readonly word: string;
  /** The pose of the face that leads a row in this state. Faces in a list never move. */
  readonly pose: Pose;
  /** The mark before the state's word on its heading. */
  readonly mark: MarkState;
}

/** The look of each Tracking state, as the Tracking drawing gives it. */
export const TRACKING_STATE_LOOKS: Readonly<Record<TrackingState, TrackingStateLook>> = {
  failed: { word: "Failed", pose: "failed", mark: "failed" },
  finished: { word: "Finished", pose: "done", mark: "done" },
  working: { word: "Working", pose: "working", mark: "working" },
  stopped: { word: "Stopped", pose: "idle", mark: "paused" },
};

/**
 * Checks whether a row in `state` can be marked done: the work has stopped, so
 * ticking it off leaves no run going. A Working row cannot, because marking it
 * done would leave its run running.
 */
export const canMarkTrackingStateDone = (state: TrackingState): boolean => state !== "working";

/**
 * Returns the words of "N wait on you", Tracking's count of rows that wait on
 * the user, or `null` for none: the head then says nothing about waiting.
 */
export const describeWaitingOnYou = (count: number): string | null =>
  count === 0 ? null : `${String(count)} ${count === 1 ? "waits" : "wait"} on you`;
