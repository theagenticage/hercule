/**
 * What the pane of a Tracking row draws, worked out from the row: the answers
 * it offers, the line under its title, the lines of its runs, and the stamp
 * beside the agent's name (spec 17 §Tracking).
 */
import type { TrackingOutputValue, TrackingRun } from "@hercule/contract";
import { formatAge } from "./threads/age";
import { formatMessageTime } from "./threads/message-time";
import { canMarkTrackingRowDone, nameTrackingState, type TrackingRow } from "./tracking";

/**
 * One answer the pane offers.
 *
 * - `stop-run`: cancels the run `runId`, the Task's newest live run.
 * - `mark-done`: takes the row off Tracking and sets its Task `done`.
 * - `cancel`: takes the row off Tracking and sets its Task `cancelled`.
 *
 * `suggested` marks the answer that `↩` presses. At most one answer of a row
 * is suggested, and Stop the run never is.
 */
export type TrackingAnswer =
  | { readonly kind: "stop-run"; readonly runId: string; readonly suggested: false }
  | { readonly kind: "mark-done" | "cancel"; readonly suggested: boolean };

/**
 * Returns the answers the pane offers for `row`, in the order it draws them.
 *
 * - A row that cannot be marked done (see `canMarkTrackingRowDone`) has a run
 *   that is going, so its only answer is to stop the Task's newest live run.
 *   Stop is never suggested, so `↩` cannot stop a run by accident.
 * - Any other row can be marked done or cancelled. Mark done is suggested on a
 *   Finished row only: a Failed, Stopped or waiting-on-a-signal row asks the
 *   user to decide, so nothing is suggested.
 *
 * Trying a failed run again is not an answer yet.
 */
export const listTrackingAnswers = (row: TrackingRow): ReadonlyArray<TrackingAnswer> => {
  if (!canMarkTrackingRowDone(row)) {
    // A row that cannot be marked done has a live run, so `latestLiveRun` is set. The row's own
    // run is a fallback that does not occur: it may have ended while an older run goes on.
    return [
      { kind: "stop-run", runId: row.task.latestLiveRun?.id ?? row.run.id, suggested: false },
    ];
  }
  return [
    { kind: "mark-done", suggested: row.state === "finished" },
    { kind: "cancel", suggested: false },
  ];
};

/**
 * Returns how long a run took as the head line reads it: "40s" under a minute,
 * then whole minutes, "8m", and from an hour on "1h 4m" or "1h" on the hour.
 */
const formatTookTime = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${String(Math.max(0, Math.floor(ms / 1000)))}s`;
  if (minutes < 60) return `${String(minutes)}m`;
  const rest = minutes % 60;
  return rest === 0
    ? `${String(minutes / 60)}h`
    : `${String(Math.floor(minutes / 60))}h ${String(rest)}m`;
};

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
    const since = formatMessageTime(new Date(row.since), timezone, now);
    return since === undefined ? "Waiting on you" : `Waiting on you since ${since}`;
  }
  const { run } = row;
  if (row.state === "working") {
    const start = readRunStart(run);
    const started = formatMessageTime(new Date(start), timezone, now);
    const age = formatAge(start, now);
    const sinceStart = age === "now" ? "just now" : `${age} so far`;
    return started === undefined
      ? `Started · ${sinceStart}`
      : `Started at ${started} · ${sinceStart}`;
  }
  const ended = formatMessageTime(new Date(readRunEnd(run)), timezone, now);
  const word = nameTrackingState(row.state);
  const when = ended === undefined ? word : `${word} at ${ended}`;
  const tookMs =
    row.state === "stopped" || run.startedAt === undefined || run.finishedAt === undefined
      ? undefined
      : Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  return tookMs === undefined ? when : `${when} after ${formatTookTime(tookMs)}`;
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
    const since = formatMessageTime(new Date(row.since), timezone, now);
    return since === undefined ? "waiting on you" : `waiting on you since ${since}`;
  }
  const ending = nameRunEnding(row.run);
  if (ending === undefined) return "working";
  const ended = formatMessageTime(new Date(readRunEnd(row.run)), timezone, now);
  return ended === undefined ? ending : `${ending} ${ended}`;
};

/**
 * Describes one value of a run's structured output as a line of the pane: a
 * string or number as it is, a boolean as "yes" or "no", and a missing value
 * (`null`) as "none". A list or an object arrives as its size only, so it
 * reads "1 item", "3 items", "1 field" or "2 fields". `muted` is true for
 * those counts and for "none", which the pane draws in the quiet colour,
 * because they stand for something that is not there to read.
 *
 * "none" rather than a dash: in a ruled row of label and value, a dash looks
 * like a drawing glitch, and a word reads as the answer it is.
 */
export const describeTrackingOutputValue = (
  value: TrackingOutputValue,
): { readonly text: string; readonly muted: boolean } => {
  if (value === null) return { text: "none", muted: true };
  if (typeof value === "boolean") return { text: value ? "yes" : "no", muted: false };
  if (typeof value === "object") {
    const [count, one, many] =
      "items" in value ? [value.items, "item", "items"] : [value.fields, "field", "fields"];
    return { text: `${count} ${count === 1 ? one : many}`, muted: true };
  }
  return { text: String(value), muted: false };
};
