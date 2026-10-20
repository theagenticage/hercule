import type { Run, RunSummary, Task } from "@hercule/contract";
import { describeFailureReason, isRunLive } from "./run-display";
import { findFailureMessage } from "./run-page-rows";

/**
 * Where the work on a Task stands, as Tracking draws it. "needs-you", the
 * state above all of these, is added with the Requests and signals that wait
 * on a Task (#802).
 *
 * - `failed`: the last run failed.
 * - `working`: a run is live.
 * - `finished`: no run is live, and the last run completed.
 * - `stopped`: the last run was cancelled.
 */
export type TrackingState = "failed" | "working" | "finished" | "stopped";

/**
 * Tracking's order of states, first to last. The rows that wait on the user
 * lead, and the rows that do not come after them. #802 puts "needs-you" first.
 */
const TRACKING_STATE_ORDER: ReadonlyArray<TrackingState> = [
  "failed",
  "finished",
  "working",
  "stopped",
];

/** How many rows folded Tracking shows: the ones that changed state last. */
const TRACKING_PEEK_ROWS = 2;

/** One row of Tracking: a Task that has runs, and the state of its work. */
export interface TrackingRow {
  readonly task: Task;
  readonly state: TrackingState;
  /**
   * The run the row's state and line are read from. It is the Task's last run
   * (newest by `createdAt`). When that run did not fail, but an older one is
   * still live, it is the newest live run instead, because the row is
   * Working. Opening the row opens this run.
   */
  readonly run: RunSummary;
  /** When the row entered its state. The time on the row's right shows how long ago that was. */
  readonly since: string;
}

/** Orders runs newest first, by `createdAt`, then by id. */
const compareNewestFirst = (a: RunSummary, b: RunSummary): number =>
  b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);

/** Returns the state a run puts its Task in. */
const decideTrackingState = (run: RunSummary): TrackingState => {
  switch (run.status) {
    case "pending":
    case "running":
      return "working";
    case "completed":
      return "finished";
    case "failed":
      return "failed";
    case "cancelled":
      return "stopped";
  }
};

/**
 * Returns when a run entered the state it puts its Task in: when it ended, or
 * for a live run when it was created. A live run's `createdAt` is used while
 * it is pending and while it runs, so a run that moves from pending to
 * running does not start its row's age again or move it in folded Tracking.
 */
const readStateStart = (run: RunSummary): string => {
  switch (run.status) {
    case "pending":
    case "running":
      return run.createdAt;
    case "completed":
    case "failed":
    case "cancelled":
      return run.finishedAt;
  }
};

/**
 * Returns when the user handed a signal to the Task's agent for the last time:
 * the `at` of the Task's latest provenance entry that has a `signalId`. Tracking
 * lists only Tasks with such an entry, so the Task's creation time is a
 * fallback that does not occur in practice.
 */
const readLatestHandoffAt = (task: Task): string =>
  task.provenance.findLast((entry) => entry.signalId !== undefined)?.at ?? task.createdAt;

/**
 * Builds Tracking's rows, in Tracking's order: Failed, Finished, Working,
 * Stopped, and inside a state the oldest handoff first (see
 * `readLatestHandoffAt`). `runs` are the runs of `tasks`, in any order.
 *
 * A Task's state follows from its runs, highest first:
 *
 * - Failed: the last run failed.
 * - Working: a run is live (pending or running).
 * - Finished: no run is live, and the last run completed.
 * - Stopped: the last run was cancelled.
 *
 * The last run is the newest by `createdAt`, then by id, so a re-run moves a
 * row to the state of the re-run. A Task with no run in `runs` has no row. A
 * handoff starts its run in the same transaction that tracks the Task, so a
 * handed-off Task without a run does not occur.
 */
export const buildTrackingRows = (
  tasks: ReadonlyArray<Task>,
  runs: ReadonlyArray<RunSummary>,
): ReadonlyArray<TrackingRow> => {
  const runsByTaskId = new Map<string, RunSummary[]>();
  for (const run of runs) {
    if (run.taskId === undefined) continue;
    const taskRuns = runsByTaskId.get(run.taskId);
    if (taskRuns === undefined) runsByTaskId.set(run.taskId, [run]);
    else taskRuns.push(run);
  }
  const rows = tasks.flatMap((task): ReadonlyArray<TrackingRow> => {
    const taskRuns = (runsByTaskId.get(task.id) ?? []).toSorted(compareNewestFirst);
    const lastRun = taskRuns[0];
    if (lastRun === undefined) return [];
    const run =
      lastRun.status === "failed"
        ? lastRun
        : (taskRuns.find((candidate) => isRunLive(candidate.status)) ?? lastRun);
    return [{ task, state: decideTrackingState(run), run, since: readStateStart(run) }];
  });
  return rows.toSorted(
    (a, b) =>
      TRACKING_STATE_ORDER.indexOf(a.state) - TRACKING_STATE_ORDER.indexOf(b.state) ||
      readLatestHandoffAt(a.task).localeCompare(readLatestHandoffAt(b.task)),
  );
};

/**
 * Returns the rows folded Tracking shows: the `TRACKING_PEEK_ROWS` rows that
 * entered their state last, newest first. A handoff lands there, and a row
 * that just finished or failed shows there.
 */
export const listRecentTrackingRows = (
  rows: ReadonlyArray<TrackingRow>,
): ReadonlyArray<TrackingRow> =>
  rows.toSorted((a, b) => b.since.localeCompare(a.since)).slice(0, TRACKING_PEEK_ROWS);

/**
 * Checks whether a row in `state` waits on the user: Failed and Finished do,
 * Working and Stopped never do. Waiting rows count toward To do.
 */
const isTrackingStateWaitingOnUser = (state: TrackingState): boolean =>
  state === "failed" || state === "finished";

/**
 * Returns how many of `rows` wait on the user. It is the "N wait on you" of
 * Tracking's head, and what Tracking adds to the To do count.
 */
export const countWaitingTrackingRows = (rows: ReadonlyArray<TrackingRow>): number =>
  rows.filter((row) => isTrackingStateWaitingOnUser(row.state)).length;

/**
 * Checks whether a row in `state` can be marked done: the work has stopped, so
 * ticking it off leaves no run going. A Working row cannot, because marking it
 * done would leave its run running.
 */
export const canMarkTrackingStateDone = (state: TrackingState): boolean => state !== "working";

/**
 * Tracking as one read returns it: the rows, and the ids of every run they
 * were worked out from. The rows are built from one read of the Tasks and one
 * of their runs, so they agree with each other.
 */
export interface TrackingSnapshot {
  /** Tracking's rows, in Tracking's order. */
  readonly rows: ReadonlyArray<TrackingRow>;
  /**
   * The ids of every run of the tracked Tasks that the read returned, sorted.
   * A row holds one run only, but a push about any of these runs can change
   * its row, such as an older run of the Task that is still live.
   */
  readonly runIds: ReadonlyArray<string>;
}

/** Builds the snapshot of `tasks` and their `runs`, as `buildTrackingRows` builds its rows. */
export const buildTrackingSnapshot = (
  tasks: ReadonlyArray<Task>,
  runs: ReadonlyArray<RunSummary>,
): TrackingSnapshot => ({
  rows: buildTrackingRows(tasks, runs),
  runIds: runs.map((run) => run.id).toSorted(),
});

/**
 * Checks whether a push on the `run` topic can change Tracking, so it must be
 * read again. `push` is the push's `ids` and `kind`. It can when:
 *
 * - it lists no ids, which means every run may have changed;
 * - it names a run that `snapshot` holds, whatever happened to it;
 * - it is the creation of a run, because a re-run keeps its Task's id and
 *   starts a run no `snapshot` holds yet, and a re-run makes no `task` push.
 *
 * Every other run, such as one a cron fire started, leaves Tracking as it is.
 */
export const isTrackingAffectedByRunPush = (
  snapshot: TrackingSnapshot,
  push: { readonly ids: ReadonlyArray<string>; readonly kind: "created" | "updated" | "deleted" },
): boolean =>
  push.ids.length === 0 ||
  push.kind === "created" ||
  push.ids.some((id) => snapshot.runIds.includes(id));

/**
 * Returns why `run` failed, in a few words for a row's line, such as
 * "permission denied on ops-db". The words come from, in this order:
 *
 * - what `findFailureMessage` finds: the `failureMessage` of a run that did
 *   not validate, the message of the edge it failed at, or the error of the
 *   step record that failed;
 * - the failure reason in plain words ("workspace failed"), when none exists.
 *
 * Returns `undefined` for a run that did not fail.
 */
export const describeRunFailureCause = (run: Run): string | undefined =>
  run.status === "failed"
    ? (findFailureMessage(run) ?? describeFailureReason(run.failureReason))
    : undefined;

/**
 * The line under a row's title. The renderer draws `workflowName` in the
 * workflow's hue, then a space, then `text`.
 */
export interface TrackingLine {
  readonly workflowName: string;
  /** What follows the workflow's name, with its own separator: "failed · reason", "finished", "· working". */
  readonly text: string;
}

/**
 * Describes the line under a row's title:
 *
 * - Failed: "Investigate failed · permission denied on ops-db". `failureCause`
 *   is what `describeRunFailureCause` returns for the row's run read with
 *   `run.read`, because a summary carries only the failure reason's code.
 *   Until it is read, the line is "Investigate failed".
 * - Finished: "Review PR finished".
 * - Working: "Fix bug · working", or "Implement · waiting for pr_checks" when
 *   the run only waits on signal triggers, which it names by their ids.
 * - Stopped: "Implement · stopped". A summary does not say who cancelled the
 *   run, so the line cannot say "stopped by you".
 *
 * The agent's latest message, which a Working line is to show, is not on any
 * record the row holds, so the line says "working" until the app reads it.
 */
export const describeTrackingLine = (row: TrackingRow, failureCause?: string): TrackingLine => {
  const workflowName = row.run.workflowName;
  switch (row.state) {
    case "failed":
      return {
        workflowName,
        text: failureCause === undefined ? "failed" : `failed · ${failureCause}`,
      };
    case "finished":
      return { workflowName, text: "finished" };
    case "working": {
      const awaited = row.run.status === "running" ? row.run.awaitedSignalIds : [];
      return {
        workflowName,
        text: awaited.length > 0 ? `· waiting for ${awaited.join(", ")}` : "· working",
      };
    }
    case "stopped":
      return { workflowName, text: "· stopped" };
  }
};

/** The rows of Tracking that are in one state. */
export interface TrackingGroup {
  readonly state: TrackingState;
  readonly rows: ReadonlyArray<TrackingRow>;
}

/**
 * Groups `rows` by state, for opened Tracking's sections. `rows` come in
 * Tracking's order, as `buildTrackingRows` returns them, so the groups come in
 * that order too and keep the rows' order inside. A state with no row has no
 * group.
 */
export const groupTrackingRows = (rows: ReadonlyArray<TrackingRow>): ReadonlyArray<TrackingGroup> =>
  TRACKING_STATE_ORDER.flatMap((state) => {
    const inState = rows.filter((row) => row.state === state);
    return inState.length === 0 ? [] : [{ state, rows: inState }];
  });
