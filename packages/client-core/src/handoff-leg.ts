import type { HandoffLeg, Signal } from "@hercule/contract";
import type { Pose } from "./threads/pose";
import {
  decideTrackingRowPose,
  isTrackingStateWaitingOnUser,
  nameTrackingState,
  type TrackingRow,
} from "./tracking";

/**
 * Where the work of a leg stands, in the words Done draws. `working` when a
 * run of the leg is live, `failed` when its newest run failed, else what the
 * newest run ended as.
 */
type LegStanding = "working" | "failed" | "finished" | "stopped";

/** The pose of the face that leads a trip in each standing. */
const LEG_STANDING_POSES: Readonly<Record<LegStanding, Pose>> = {
  working: "working",
  failed: "failed",
  finished: "done",
  stopped: "idle",
};

/**
 * Where a Done row goes to show its trip in full: the Task's row in Tracking, or
 * the page of a run.
 */
export type HandoffTripDestination =
  | { readonly kind: "tracking"; readonly taskId: string }
  | { readonly kind: "run"; readonly runId: string };

/**
 * The line under a Done row of a signal that was handed to an agent: "Handed
 * to Fix bug → tried again once → done". The renderer joins `steps` and the
 * text of `end` with " → ".
 */
export interface HandoffTrip {
  /** Every step but the last, such as "Handed to Fix bug" and "tried again once". */
  readonly steps: ReadonlyArray<string>;
  /**
   * The last step. `tone` is set only when `text` is the word of a Tracking
   * state: `finished` for Finished, which is good news, and `waits` for the
   * other states that wait on the user (Needs you, Failed).
   */
  readonly end: { readonly text: string; readonly tone: "waits" | "finished" | null };
  /** The text the face that leads the row is drawn from: the handed-to workflow's id, else its name. */
  readonly faceSeed: string;
  /** The pose of the face that leads the row. */
  readonly pose: Pose;
  readonly destination: HandoffTripDestination;
}

/** Returns where the work of `leg` stands. */
const decideLegStanding = (leg: HandoffLeg): LegStanding => {
  if (leg.latestRun.status === "failed") return "failed";
  if (leg.liveRunIds.length > 0) return "working";
  switch (leg.latestRun.status) {
    case "completed":
      return "finished";
    case "cancelled":
      return "stopped";
    case "pending":
    case "running":
      return "working";
  }
};

/** Returns how a trip says the handoff was tried again `count` times, such as "tried again twice". */
const describeRerunCount = (count: number): string => {
  switch (count) {
    case 1:
      return "tried again once";
    case 2:
      return "tried again twice";
    default:
      return `tried again ${count} times`;
  }
};

/**
 * Describes the trip of the handoff that resolved `signal`, or returns `null`
 * when the row has no trip to draw and shows its outcome line instead. That is
 * the case when there is no `leg`, or the leg belongs to another signal or
 * another run than the one the signal's resolution started.
 *
 * The trip reads "Handed to <workflow>", then "tried again <n>" when the
 * handoff was re-run, then where it ends:
 *
 * - The Task was handed on again (the leg has a `next`): the standing of the
 *   leg, then "continued: <next workflow>".
 * - The Task is done or cancelled: "done" or "cancelled".
 * - The Task is in progress and `trackingRow` shows this very handoff as its
 *   newest: the word of the row's Tracking state. When the leg ended with
 *   another word than the row (a run finished, but the row needs you), the
 *   leg's own word comes before it.
 * - Anything else, such as a Task that is open or whose row is not loaded or
 *   already follows a newer handoff: the standing of the leg. A missing row
 *   never means the Task is done.
 *
 * The face is the handed-to workflow's. Its pose is the row's while the row
 * agrees with the leg, else the pose of the Task or the leg's standing.
 */
export const describeHandoffTrip = (
  signal: Signal,
  leg: HandoffLeg | undefined,
  trackingRow: TrackingRow | undefined,
): HandoffTrip | null => {
  if (leg === undefined || leg.signalId !== signal.id || leg.runId !== signal.resolution?.runId) {
    return null;
  }
  const standing = decideLegStanding(leg);
  const steps = [
    `Handed to ${leg.workflowName}`,
    ...(leg.rerunCount > 0 ? [describeRerunCount(leg.rerunCount)] : []),
  ];
  const faceSeed = leg.workflowId ?? leg.workflowName;
  const runDestination = { kind: "run", runId: leg.latestRun.id } as const;
  const ownEnd = { text: standing, tone: null };
  const ownPose = LEG_STANDING_POSES[standing];

  if (leg.next !== undefined) {
    return {
      steps: [...steps, standing],
      end: { text: `continued: ${leg.next.workflowName}`, tone: null },
      faceSeed,
      pose: ownPose,
      destination: runDestination,
    };
  }
  switch (leg.taskStatus) {
    case "done":
      return {
        steps,
        end: { text: "done", tone: null },
        faceSeed,
        pose: "done",
        destination: runDestination,
      };
    case "cancelled":
      return {
        steps,
        end: { text: "cancelled", tone: null },
        faceSeed,
        pose: "idle",
        destination: runDestination,
      };
    case "open":
      return { steps, end: ownEnd, faceSeed, pose: ownPose, destination: runDestination };
    case "in-progress": {
      const row =
        trackingRow?.task.taskId === leg.taskId && trackingRow.task.handoffs[0]?.runId === leg.runId
          ? trackingRow
          : undefined;
      if (row === undefined) {
        return { steps, end: ownEnd, faceSeed, pose: ownPose, destination: runDestination };
      }
      const trackingWord = nameTrackingState(row.state).toLowerCase();
      const hasEnded = leg.liveRunIds.length === 0 && standing !== trackingWord;
      return {
        steps: hasEnded ? [...steps, standing] : steps,
        end: {
          text: trackingWord,
          tone:
            row.state === "finished"
              ? "finished"
              : isTrackingStateWaitingOnUser(row.state)
                ? "waits"
                : null,
        },
        faceSeed,
        pose: decideTrackingRowPose(row),
        destination: { kind: "tracking", taskId: leg.taskId },
      };
    }
  }
};

/**
 * Checks whether a push on the `run` topic means the Done reads must be read
 * again. `legs` are every leg the Done reads hold, and `push` is the push's
 * `ids` and `kind`. It is true when:
 *
 * - the push lists no ids, which means every run may have changed;
 * - a run was created, because a re-run starts a run no leg holds yet and makes
 *   no `task` push;
 * - a run the push names is a leg's newest run or one of its live runs.
 *
 * A push that names only other runs, such as one a cron fire started, leaves
 * every trip as it was.
 */
export const isAnyLegAffectedByRunPush = (
  legs: ReadonlyArray<HandoffLeg>,
  push: { readonly ids: ReadonlyArray<string>; readonly kind: "created" | "updated" | "deleted" },
): boolean =>
  push.ids.length === 0 ||
  push.kind === "created" ||
  legs.some(
    (leg) =>
      push.ids.includes(leg.latestRun.id) || leg.liveRunIds.some((id) => push.ids.includes(id)),
  );
