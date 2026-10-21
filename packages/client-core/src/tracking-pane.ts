/**
 * What the pane of a Tracking row draws, worked out from the row: the answers
 * it offers, the line under its title, the trip of its work, and the stamp
 * beside the agent's name (spec 17 §Tracking).
 */
import type {
  TrackingDetail,
  TrackingOutput,
  TrackingOutputValue,
  TrackingRun,
} from "@hercule/contract";
import { isRunLive } from "./run-display";
import { formatMessageTime } from "./threads/message-time";
import { canMarkTrackingRowDone, nameTrackingState, type TrackingRow } from "./tracking";

/**
 * One answer the pane offers.
 *
 * - `stop-run`: cancels `run`, the Task's newest live run. That is not always
 *   the row's own run: a Failed row can belong to a Task whose older run still
 *   goes. `leavesRowStopped` is true when cancelling `run` leaves the row
 *   Stopped. It is false when the row stays in another state: another run is
 *   still live, `run` is not the Task's newest run so an earlier run's state
 *   shows, or the row waits on a signal.
 * - `mark-done`: takes the row off Tracking and sets its Task `done`.
 * - `cancel`: takes the row off Tracking and sets its Task `cancelled`.
 *
 * `suggested` marks the answer that `↩` presses. At most one answer of a row
 * is suggested, and Stop the run never is.
 */
export type TrackingAnswer =
  | {
      readonly kind: "stop-run";
      readonly run: TrackingRun;
      readonly leavesRowStopped: boolean;
      readonly suggested: false;
    }
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
    // The controller sets `latestLiveRun` whenever a run is live, but the type
    // leaves it optional, so the row's own run stands in for a missing one.
    const run = row.task.latestLiveRun ?? row.run;
    const leavesRowStopped =
      run.id === row.task.latestRun.id &&
      row.task.liveRunIds.every((runId) => runId === run.id) &&
      !(row.state === "needs-you" && row.waitsOn.kind === "signal");
    return [{ kind: "stop-run", run, leavesRowStopped, suggested: false }];
  }
  return [
    { kind: "mark-done", suggested: row.state === "finished" },
    { kind: "cancel", suggested: false },
  ];
};

/**
 * Returns a time span as the pane reads it: "40s" under a minute, then whole
 * minutes, "8m", and from an hour on "1h 4m", or "1h" on the hour. The pane
 * writes every duration this way, both how long a finished run took and how
 * long a working run has gone on.
 */
const formatRunDuration = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${String(Math.max(0, Math.floor(ms / 1000)))}s`;
  if (minutes < 60) return `${String(minutes)}m`;
  const rest = minutes % 60;
  return rest === 0
    ? `${String(minutes / 60)}h`
    : `${String(Math.floor(minutes / 60))}h ${String(rest)}m`;
};

/**
 * Returns the first moment after `now` at which a duration since `since`,
 * written by `formatRunDuration` in whole minutes, reads differently: the next
 * whole minute after `since`. The duration of a run that started less than a
 * minute ago reads "just now", and changes at the same moment. A `since`
 * later than `now` changes one minute after `since`.
 */
export const findNextTrackingElapsedChange = (since: string, now: Date): Date => {
  const start = Date.parse(since);
  const minutes = Math.max(0, Math.floor((now.getTime() - start) / 60_000));
  return new Date(start + (minutes + 1) * 60_000);
};

/** Returns when a run ended, or for a run that has not ended, when it was created. */
const readRunEnd = (run: TrackingRun): string => run.finishedAt ?? run.createdAt;

/** Returns when a run started, or when it was created if it has not started. */
export const readTrackingRunStart = (run: TrackingRun): string => run.startedAt ?? run.createdAt;

/** What each status of a run is drawn as: the pose of its mark, and the word that says where it stands. */
const RUN_STATUS_FACTS: Readonly<
  Record<
    TrackingRun["status"],
    { readonly pose: "working" | "done" | "failed" | "idle"; readonly word: string }
  >
> = {
  completed: { pose: "done", word: "finished" },
  failed: { pose: "failed", word: "failed" },
  cancelled: { pose: "idle", word: "stopped" },
  pending: { pose: "working", word: "working" },
  running: { pose: "working", word: "working" },
};

/**
 * Describes one run as the pane draws it:
 *
 * - `pose`: the pose of the mark that leads the run: `working` for a live run,
 *   `done` for a completed one, `failed` for a failed one and `idle` for a
 *   cancelled one, as the rows of Tracking mark the same states.
 * - `word`: "finished", "failed", "stopped" or "working".
 * - `text`: what follows the workflow's name in the list of runs. It is the
 *   word, except that a failed run with a `failureCause` reads "failed:
 *   permission denied on ops-db", and a live run that only waits on signal
 *   triggers reads "waiting for pr_checks, pr_merged", naming them by id.
 */
export const describeTrackingRun = (
  run: TrackingRun,
): {
  readonly pose: "working" | "done" | "failed" | "idle";
  readonly word: string;
  readonly text: string;
} => {
  const { pose, word } = RUN_STATUS_FACTS[run.status];
  if (run.status === "failed" && run.failureCause !== undefined) {
    return { pose, word, text: `${word}: ${run.failureCause}` };
  }
  if (isRunLive(run.status) && run.awaitedSignalIds.length > 0) {
    return { pose, word, text: `waiting for ${run.awaitedSignalIds.join(", ")}` };
  }
  return { pose, word, text: word };
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
    const start = readTrackingRunStart(run);
    const started = formatMessageTime(new Date(start), timezone, now);
    const elapsedMs = now.getTime() - Date.parse(start);
    const sinceStart = elapsedMs < 60_000 ? "just now" : `${formatRunDuration(elapsedMs)} so far`;
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
  return tookMs === undefined ? when : `${when} after ${formatRunDuration(tookMs)}`;
};

/**
 * Checks whether the pane draws its list of runs. `runs` are the Task's runs,
 * oldest first. The list is drawn when there are two or more runs, or when the
 * newest one is live. With one run that has ended, the list would repeat what
 * the pane's name line and its links already say.
 */
const shouldListTrackingRuns = (runs: ReadonlyArray<TrackingRun>): boolean => {
  const newest = runs.at(-1);
  return runs.length >= 2 || (newest !== undefined && isRunLive(newest.status));
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
  const { word } = describeTrackingRun(row.run);
  if (isRunLive(row.run.status)) return word;
  const ended = formatMessageTime(new Date(readRunEnd(row.run)), timezone, now);
  return ended === undefined ? word : `${word} ${ended}`;
};

/** One run in the trip's list of runs, with everything its line draws worked out. */
export interface TrackingTripRun {
  readonly runId: string;
  /** When the run ended, or when it started if it is live, as a time. Empty when it cannot be formatted. */
  readonly time: string;
  /** The ISO time `time` is of. */
  readonly timeAt: string;
  /** The pose of the mark that leads the line (see `describeTrackingRun`). */
  readonly pose: "working" | "done" | "failed" | "idle";
  readonly live: boolean;
  readonly workflowName: string;
  /** The text the colour of the workflow's name is drawn from, the same as for the workflow's face. */
  readonly faceSeed: string;
  /** How the run went: "finished", "failed: reason", "working" (see `describeTrackingRun`). */
  readonly text: string;
  /** The session of the run's last agent step, when it has one. */
  readonly sessionId: string | undefined;
}

/** What the trip of the pane draws, worked out from the row and the Task's read. */
export interface TrackingTrip {
  /** What follows "You asked": when the Task was first handed off, and to which workflow ("09:12 · handed to Review PR"). */
  readonly askedSmall: string;
  /** The stamp beside the agent's name (see `describeTrackingStamp`). */
  readonly stamp: string;
  /** Why the run failed. Set on a Failed row only, and only when the run carries a cause. */
  readonly failureCause: string | undefined;
  /** What the newest run's last agent step put out. Absent on a Working row, and when the run has none. */
  readonly output: TrackingOutput | undefined;
  /** The run "See the whole output" opens: the newest run, whose output it is. */
  readonly outputRunId: string;
  /** The action step the newest run ended on. Absent on a Working row, and when the run did not end on one. */
  readonly endingActionStepName: string | undefined;
  /** The runs, oldest first. Empty when the list adds nothing to the agent's name line (see `shouldListTrackingRuns`). */
  readonly runs: ReadonlyArray<TrackingTripRun>;
}

/**
 * Describes the trip of `row` from the Task's read `detail`, with times in
 * `timezone` as seen from `now`.
 *
 * The output and the ending action step belong to the newest run. A Working
 * row names its newest live run, which can be an older run than the newest,
 * so the pane leaves both out there: they would sit under the wrong run's
 * name, and a run that goes on has not ended on anything.
 */
export const describeTrackingTrip = (
  row: TrackingRow,
  detail: TrackingDetail,
  timezone: string,
  now: Date,
): TrackingTrip => {
  const handedTo = `handed to ${detail.firstHandoff.workflowName}`;
  const handedAt = formatMessageTime(new Date(detail.firstHandoff.at), timezone, now);
  const ended = row.state !== "working";
  return {
    askedSmall: handedAt === undefined ? handedTo : `${handedAt} · ${handedTo}`,
    stamp: describeTrackingStamp(row, timezone, now),
    failureCause: row.state === "failed" ? row.run.failureCause : undefined,
    output: ended ? detail.output : undefined,
    outputRunId: detail.runs.at(-1)?.id ?? row.run.id,
    endingActionStepName: ended ? detail.endingActionStepName : undefined,
    runs: shouldListTrackingRuns(detail.runs)
      ? detail.runs.map((run) => {
          // A run that has not ended is led by when it started.
          const timeAt = run.finishedAt ?? readTrackingRunStart(run);
          const { pose, text } = describeTrackingRun(run);
          return {
            runId: run.id,
            time: formatMessageTime(new Date(timeAt), timezone, now) ?? "",
            timeAt,
            pose,
            live: isRunLive(run.status),
            workflowName: run.workflowName,
            faceSeed: run.workflowId ?? run.workflowName,
            text,
            sessionId: run.sessionId,
          };
        })
      : [],
  };
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
