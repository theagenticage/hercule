import type { TrackingRun, TrackingTask } from "@hercule/contract";
import { isRunLive } from "./run-display";

/**
 * Where the work on a Task stands, as Tracking draws it. "needs-you", the
 * state above all of these, is added with the Requests and signals that wait
 * on a Task (#802).
 *
 * - `failed`: the newest run failed.
 * - `working`: a run is live.
 * - `finished`: no run is live, and the newest run completed.
 * - `stopped`: the newest run was cancelled.
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
  /** The Task as `task.queryTracking` returns it: its title, its handoffs and its newest runs. */
  readonly task: TrackingTask;
  readonly state: TrackingState;
  /**
   * The run the row's state and line are read from. It is the Task's newest
   * run. When that run did not fail, but another is still live, it is the
   * newest live run instead, because the row is Working. Opening the row opens
   * this run.
   */
  readonly run: TrackingRun;
  /** When the row entered its state. The time on the row's right shows how long ago that was. */
  readonly since: string;
}

/** Returns the state a run puts its Task in. */
const decideTrackingState = (run: TrackingRun): TrackingState => {
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
const readStateStart = (run: TrackingRun): string =>
  isRunLive(run.status) ? run.createdAt : (run.finishedAt ?? run.createdAt);

/**
 * Returns when the user handed a signal to the Task's agent for the last time:
 * the `at` of its newest handoff, which `task.queryTracking` lists first. A
 * tracked Task always has one, so the newest run's creation is a
 * fallback that does not occur in practice.
 */
const readLatestHandoffAt = (task: TrackingTask): string =>
  task.handoffs[0]?.at ?? task.latestRun.createdAt;

/**
 * Builds Tracking's rows from the Tasks `task.queryTracking` returns, in
 * Tracking's order: Failed, Finished, Working, Stopped, and inside a state the
 * oldest handoff first (see `readLatestHandoffAt`).
 *
 * A Task's state follows from its runs, highest first:
 *
 * - Failed: the newest run failed.
 * - Working: a run is live (pending or running), so the row reads the newest
 *   live run.
 * - Finished: no run is live, and the newest run completed.
 * - Stopped: the newest run was cancelled.
 *
 * A re-run is the newest run, so it moves a row to its own state.
 */
export const buildTrackingRows = (tasks: ReadonlyArray<TrackingTask>): ReadonlyArray<TrackingRow> =>
  tasks
    .map((task): TrackingRow => {
      const run =
        task.latestRun.status !== "failed" && task.latestLiveRun !== undefined
          ? task.latestLiveRun
          : task.latestRun;
      return { task, state: decideTrackingState(run), run, since: readStateStart(run) };
    })
    .toSorted(
      (a, b) =>
        TRACKING_STATE_ORDER.indexOf(a.state) - TRACKING_STATE_ORDER.indexOf(b.state) ||
        readLatestHandoffAt(a.task).localeCompare(readLatestHandoffAt(b.task)),
    );

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
 * Checks whether a push on the `run` topic can change Tracking, so it must be
 * read again. `push` is the push's `ids` and `kind`. It can when:
 *
 * - it lists no ids, which means every run may have changed;
 * - it names the newest run, or the newest live run, of a row of `rows`,
 *   whatever happened to it;
 * - it is the creation of a run, because a re-run keeps its Task's id and
 *   starts a run no row holds yet, and a re-run makes no `task` push.
 *
 * Every other run, such as one a cron fire started, leaves Tracking as it is.
 */
export const isTrackingAffectedByRunPush = (
  rows: ReadonlyArray<TrackingRow>,
  push: { readonly ids: ReadonlyArray<string>; readonly kind: "created" | "updated" | "deleted" },
): boolean =>
  push.ids.length === 0 ||
  push.kind === "created" ||
  rows.some(
    (row) =>
      push.ids.includes(row.task.latestRun.id) ||
      (row.task.latestLiveRun !== undefined && push.ids.includes(row.task.latestLiveRun.id)),
  );

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
 * - Failed: "Investigate failed · permission denied on ops-db", from the
 *   `failureCause` the row's run carries. With none, the line is "Investigate
 *   failed".
 * - Finished: "Review PR finished".
 * - Working: "Fix bug · working", or "Implement · waiting for pr_checks" when
 *   the run only waits on signal triggers, which it names by their ids.
 * - Stopped: "Implement · stopped". The run's facts do not say who cancelled the
 *   run, so the line cannot say "stopped by you".
 *
 * The agent's latest message, which a Working line is to show, is not on any
 * record the row holds, so the line says "working" until the app reads it.
 */
export const describeTrackingLine = (row: TrackingRow): TrackingLine => {
  const workflowName = row.run.workflowName;
  switch (row.state) {
    case "failed":
      return {
        workflowName,
        text: row.run.failureCause === undefined ? "failed" : `failed · ${row.run.failureCause}`,
      };
    case "finished":
      return { workflowName, text: "finished" };
    case "working": {
      const awaited = row.run.awaitedSignalIds;
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
