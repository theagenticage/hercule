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
 * Returns the row of `leg`'s Task when `trackingRow` shows what the leg shows,
 * else `undefined`. The two agree only when all of these hold:
 *
 * - the row is for the leg's Task;
 * - the row's newest handoff is the leg's handoff, and the leg was not handed
 *   on again;
 * - the row's newest run is the leg's newest run, in the same status;
 * - the row's live runs are the leg's live runs: the same ids, in any order.
 *
 * Done and Tracking are read at different moments. When any of these differ,
 * one read is older than the other, or a re-run of another leg is newer, and
 * the row's state would describe a different moment than the leg does.
 *
 * The live runs condition also rejects a row whose Task has a live run in
 * another leg. That is intended: the trip then falls back to the standing of
 * the leg, which is always true, and only loses the Tracking colour in a rare
 * case.
 */
const findAgreeingRow = (leg: HandoffLeg, trackingRow: TrackingRow | undefined) =>
  trackingRow !== undefined &&
  trackingRow.task.taskId === leg.taskId &&
  trackingRow.task.handoffs[0]?.runId === leg.runId &&
  leg.next === undefined &&
  trackingRow.task.latestRun.id === leg.latestRun.id &&
  trackingRow.task.latestRun.status === leg.latestRun.status &&
  hasSameIds(trackingRow.task.liveRunIds, leg.liveRunIds)
    ? trackingRow
    : undefined;

/** Checks that `a` and `b` hold the same set of ids, in any order. */
const hasSameIds = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  new Set(a).size === new Set(b).size && a.every((id) => b.includes(id));

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
 * - The Task is in progress and `trackingRow` agrees with the leg (see
 *   `findAgreeingRow`): the word of the row's Tracking state. When the leg
 *   ended with another word than the row (a run finished, but the row needs
 *   you), the leg's own word comes before it.
 * - Anything else, such as a Task that is open, or whose row is not loaded,
 *   is newer than the leg or is older than it: the standing of the leg. A
 *   missing row never means the Task is done.
 *
 * The face is the handed-to workflow's. Its pose is the row's while the row
 * agrees with the leg, else the pose of the Task or the leg's standing.
 *
 * Opening the line goes to the Task's row in Tracking while the Task is in
 * progress and that row is loaded, whichever leg it is and whether or not the
 * row agrees with it. Otherwise it goes to the leg's newest run.
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
  const row = leg.taskStatus === "in-progress" ? findAgreeingRow(leg, trackingRow) : undefined;

  // How the trip ends, its face's pose, and whether the leg's own standing
  // comes before the end.
  let end: HandoffTrip["end"] = { text: standing, tone: null };
  let pose = LEG_STANDING_POSES[standing];
  let showsOwnStanding = false;
  if (leg.next !== undefined) {
    end = { text: `continued: ${leg.next.workflowName}`, tone: null };
    showsOwnStanding = true;
  } else if (leg.taskStatus === "done") {
    end = { text: "done", tone: null };
    pose = "done";
  } else if (leg.taskStatus === "cancelled") {
    end = { text: "cancelled", tone: null };
    pose = "idle";
  } else if (row !== undefined) {
    const trackingWord = nameTrackingState(row.state).toLowerCase();
    end = {
      text: trackingWord,
      tone:
        row.state === "finished"
          ? "finished"
          : isTrackingStateWaitingOnUser(row.state)
            ? "waits"
            : null,
    };
    pose = decideTrackingRowPose(row);
    showsOwnStanding = leg.liveRunIds.length === 0 && standing !== trackingWord;
  }

  const opensTracking = leg.taskStatus === "in-progress" && trackingRow?.task.taskId === leg.taskId;
  return {
    steps: [
      `Handed to ${leg.workflowName}`,
      ...(leg.rerunCount > 0 ? [describeRerunCount(leg.rerunCount)] : []),
      ...(showsOwnStanding ? [standing] : []),
    ],
    end,
    faceSeed: leg.workflowId ?? leg.workflowName,
    pose,
    destination: opensTracking
      ? { kind: "tracking", taskId: leg.taskId }
      : { kind: "run", runId: leg.latestRun.id },
  };
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
 * An `updated` or `deleted` push that names only other runs leaves every trip
 * as it was. A `created` push never does: a cron fire's run is no different
 * from a re-run until the Done reads are read again.
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

/**
 * Checks whether a push on the `task` topic means the Done reads must be read
 * again. `legs` are every leg the Done reads hold, and `push` is the push's
 * `ids`. It is true when the push lists no ids, which means every Task may
 * have changed, or names the Task of a held leg.
 *
 * A new handoff on a Task always resolves a signal, which a `signal` push
 * covers, so a Task that no held leg names cannot change a trip.
 */
export const isAnyLegAffectedByTaskPush = (
  legs: ReadonlyArray<HandoffLeg>,
  push: { readonly ids: ReadonlyArray<string> },
): boolean => push.ids.length === 0 || legs.some((leg) => push.ids.includes(leg.taskId));
