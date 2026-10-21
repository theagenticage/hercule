/**
 * What the pane of a Tracking row draws, worked out from the row: the answers
 * it offers, the line under its title, the lines of its runs, and the stamp
 * beside the agent's name (spec 17 §Tracking).
 */
import type { TrackingRun } from "@hercule/contract";
import { formatAge } from "./threads/age";
import { formatDuration } from "./threads/duration";
import { formatMessageTime } from "./threads/message-time";
import { canMarkTrackingRowDone, nameTrackingState, type TrackingRow } from "./tracking";

/**
 * One answer the pane offers.
 *
 * - `stop-run`: cancels the run that is going.
 * - `mark-done`: takes the row off Tracking and sets its Task `done`.
 * - `cancel`: takes the row off Tracking and sets its Task `cancelled`.
 *
 * `suggested` marks the answer that `↩` presses. At most one answer of a row
 * is suggested.
 */
export interface TrackingAnswer {
  readonly kind: "stop-run" | "mark-done" | "cancel";
  readonly suggested: boolean;
}

/**
 * Returns the answers the pane offers for `row`, in the order it draws them.
 *
 * - A row that cannot be marked done (see `canMarkTrackingRowDone`) has a run
 *   that is going, so its only answer is to stop that run. Stop is never
 *   suggested, so `↩` cannot stop a run by accident.
 * - Any other row can be marked done or cancelled. Mark done is suggested on a
 *   Finished row only: a Failed, Stopped or waiting-on-a-signal row asks the
 *   user to decide, so nothing is suggested.
 *
 * Trying a failed run again is not an answer yet.
 */
export const listTrackingAnswers = (row: TrackingRow): ReadonlyArray<TrackingAnswer> => {
  if (!canMarkTrackingRowDone(row)) return [{ kind: "stop-run", suggested: false }];
  return [
    { kind: "mark-done", suggested: row.state === "finished" },
    { kind: "cancel", suggested: false },
  ];
};

/**
 * Returns the time of `instant` as a person reads it ("09:20", or "4 Sep 09:20"
 * on another day), or `undefined` when the time cannot be formatted, so the
 * caller leaves the time out rather than show a wrong one.
 */
const formatMoment = (instant: string, timezone: string, now: Date): string | undefined =>
  formatMessageTime(new Date(instant), timezone, now);

/** Returns when a run ended, or for a run that has not ended, when it was created. */
const readRunEnd = (run: TrackingRun): string => run.finishedAt ?? run.createdAt;

/** Returns when a run started, or when it was created if it has not started. */
const readRunStart = (run: TrackingRun): string => run.startedAt ?? run.createdAt;

/**
 * Returns how a run that is not live ended, as a lower-case word: "finished",
 * "failed" or "stopped". A run that is live returns `undefined`.
 */
const nameRunEnding = (run: TrackingRun): "finished" | "failed" | "stopped" | undefined => {
  switch (run.status) {
    case "completed":
      return "finished";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
    case "pending":
    case "running":
      return undefined;
  }
};

/**
 * Describes where the work on `row` stands, for the line under the pane's
 * title, with times in `timezone` as seen from `now`:
 *
 * - Needs you: "Waiting on you since 09:33".
 * - Finished: "Finished at 09:20 after 8m". Failed: "Failed at 09:26 after 6m".
 *   The duration runs from when the run started, and is left out for a run that
 *   never started.
 * - Stopped: "Stopped at 08:47". The run's facts do not say who stopped it, so
 *   the line never says "by you".
 * - Working: "Started at 09:33 · 8m so far", or "Started at 09:33 · just now"
 *   in the first minute.
 *
 * A time that cannot be formatted is left out with its "at" or "since".
 */
export const describeTrackingStanding = (row: TrackingRow, timezone: string, now: Date): string => {
  if (row.state === "needs-you") {
    const since = formatMoment(row.since, timezone, now);
    return since === undefined ? "Waiting on you" : `Waiting on you since ${since}`;
  }
  const { run } = row;
  if (row.state === "working") {
    const start = readRunStart(run);
    const started = formatMoment(start, timezone, now);
    const age = formatAge(start, now);
    const sinceStart = age === "now" ? "just now" : `${age} so far`;
    return started === undefined
      ? `Started · ${sinceStart}`
      : `Started at ${started} · ${sinceStart}`;
  }
  const ended = formatMoment(readRunEnd(run), timezone, now);
  const word = nameTrackingState(row.state);
  const when = ended === undefined ? word : `${word} at ${ended}`;
  const tookMs =
    row.state === "stopped" || run.startedAt === undefined || run.finishedAt === undefined
      ? undefined
      : Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  return tookMs === undefined ? when : `${when} after ${formatDuration(tookMs)}`;
};

/**
 * Describes one run for the pane's list of runs: what follows the workflow's
 * name. A completed run is "finished", a cancelled one "stopped". A failed run
 * is "failed: permission denied on ops-db" with the `failureCause` it carries,
 * or "failed" with none. A live run is "working", or "waiting for pr_checks,
 * pr_merged" when it only waits on signal triggers, which it names by their ids.
 */
export const describeTrackingRunLine = (run: TrackingRun): string => {
  switch (run.status) {
    case "completed":
      return "finished";
    case "failed":
      return run.failureCause === undefined ? "failed" : `failed: ${run.failureCause}`;
    case "cancelled":
      return "stopped";
    case "pending":
    case "running":
      return run.awaitedSignalIds.length > 0
        ? `waiting for ${run.awaitedSignalIds.join(", ")}`
        : "working";
  }
};

/**
 * Describes the small stamp beside the agent's name in the pane, with times in
 * `timezone` as seen from `now`:
 *
 * - "finished 09:20", "failed 09:26" or "stopped 08:47", from the row's run.
 *   A Needs you row that waits on a signal is stamped by its run too, because
 *   the agent has ended and the signal is what waits.
 * - "waiting on you since 09:33", for a row that waits on a Request.
 * - "working", while the row's run is live.
 *
 * A time that cannot be formatted is left out, so the stamp is the word alone.
 */
export const describeTrackingStamp = (row: TrackingRow, timezone: string, now: Date): string => {
  if (row.state === "needs-you" && row.waitsOn.kind === "request") {
    const since = formatMoment(row.since, timezone, now);
    return since === undefined ? "waiting on you" : `waiting on you since ${since}`;
  }
  const ending = nameRunEnding(row.run);
  if (ending === undefined) return "working";
  const ended = formatMoment(readRunEnd(row.run), timezone, now);
  return ended === undefined ? ending : `${ending} ${ended}`;
};
