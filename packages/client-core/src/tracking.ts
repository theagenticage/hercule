import type { Signal, TrackingRun, TrackingTask } from "@hercule/contract";
import { nameSignalKind } from "./intake";
import { isRunLive } from "./run-display";
import type { Pose } from "./threads/pose";
import type { WaitingRunSession } from "./waiting";
import type { YourWork } from "./your-work";

/**
 * Where the work on a Task stands, as Tracking draws it.
 *
 * - `needs-you`: the work waits on the user, whatever its runs did. A session
 *   of a live run has an open Request, or an open signal on To do names the
 *   Task as Your work.
 * - `failed`: the newest run failed.
 * - `working`: a run is live.
 * - `finished`: no run is live, and the newest run completed.
 * - `stopped`: the newest run was cancelled.
 */
export type TrackingState = "needs-you" | "failed" | "working" | "finished" | "stopped";

/**
 * Tracking's order of states, first to last. The rows that wait on the user
 * lead, and the rows that do not come after them.
 */
const TRACKING_STATE_ORDER: ReadonlyArray<TrackingState> = [
  "needs-you",
  "failed",
  "finished",
  "working",
  "stopped",
];

/** The word Tracking calls each state by: on its headings, and where Your work says what its row is doing. */
const TRACKING_STATE_WORDS: Readonly<Record<TrackingState, string>> = {
  "needs-you": "Needs you",
  failed: "Failed",
  finished: "Finished",
  working: "Working",
  stopped: "Stopped",
};

/** Returns the word Tracking calls `state` by, such as "Needs you". */
export const nameTrackingState = (state: TrackingState): string => TRACKING_STATE_WORDS[state];

/**
 * Returns the text the colleague's face that leads `row` is drawn from: the
 * id of the workflow that has the work, or its name when the run has no
 * workflow (a workflow sent with the request). The same text always gives the
 * same face, so every place that shows the agent on a Task shows one face.
 */
export const readTrackingFaceSeed = (row: TrackingRow): string =>
  row.run.workflowId ?? row.run.workflowName;

/** The pose of the face that leads a row in each state. Faces in a list never move. */
const TRACKING_STATE_POSES: Readonly<Record<TrackingState, Pose>> = {
  "needs-you": "waiting",
  failed: "failed",
  finished: "done",
  working: "working",
  stopped: "idle",
};

/** Returns the pose of the face that leads a row in `state`, such as `waiting` for Needs you. */
export const decideTrackingStatePose = (state: TrackingState): Pose => TRACKING_STATE_POSES[state];

/** How many rows folded Tracking shows: the ones that changed state last. */
const TRACKING_PEEK_ROWS = 2;

/**
 * What a read of Tracking gives: the Tasks `task.queryTracking` returns, and
 * when the read started. The rows are built from the Tasks together with what
 * waits on the user (`buildTrackingRows`). The time is on the clock of
 * `performance.now()`, taken before the request was sent, so everything the
 * Tasks show is as the controller held it from that moment on. The app
 * compares it with the time the user's own handoff committed.
 */
export interface TrackingRead {
  readonly tasks: ReadonlyArray<TrackingTask>;
  readonly readStartedAt: number;
}

/** What a Needs you row waits on: an open Request of a run's session, or an open signal. */
type TrackingWait =
  | { readonly kind: "request"; readonly session: WaitingRunSession }
  | { readonly kind: "signal"; readonly signal: Signal };

/** The fields every row of Tracking has. */
interface TrackingRowBase {
  /** The Task as `task.queryTracking` returns it: its title, its handoffs and its newest runs. */
  readonly task: TrackingTask;
  /**
   * The run the row shows: its face, its line and its time are read from it.
   * It is the Task's newest run. When that run did not fail, but another is
   * still live, it is the newest live run instead, because the row is Working.
   * A Needs you row keeps this run too.
   */
  readonly run: TrackingRun;
  /**
   * When the row entered its state. The time on the row's right shows how long
   * ago that was. For a Needs you row it is when the session of the Request was
   * last active, or when the signal was raised.
   */
  readonly since: string;
}

/** One row of Tracking: a Task that has runs, and the state of its work. */
export type TrackingRow =
  | (TrackingRowBase & {
      readonly state: "needs-you";
      /** What the row waits on, which opening the row goes to. */
      readonly waitsOn: TrackingWait;
    })
  | (TrackingRowBase & { readonly state: Exclude<TrackingState, "needs-you"> });

/** Returns the state a run puts its Task in. Needs you never comes from a run. */
const decideTrackingState = (run: TrackingRun): Exclude<TrackingState, "needs-you"> => {
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
 * Returns, for each Task that Your work names, the oldest signal that names
 * it (by `createdAt`, then id). Picking the oldest keeps a row's signal the
 * same when a newer signal about the Task arrives.
 */
const indexOldestSignalByTask = (yourWork: YourWork): ReadonlyMap<string, Signal> => {
  const oldestByTask = new Map<string, Signal>();
  const entries = [...yourWork.values()].toSorted(
    (a, b) =>
      a.signal.createdAt.localeCompare(b.signal.createdAt) ||
      a.signal.id.localeCompare(b.signal.id),
  );
  for (const { signal, tasks } of entries) {
    for (const task of tasks) {
      if (!oldestByTask.has(task.id)) oldestByTask.set(task.id, signal);
    }
  }
  return oldestByTask;
};

/**
 * Returns what a Task waits on, or `undefined` when it waits on nothing. A
 * Request wins over a signal, because an agent is blocked until it is
 * answered. When several Requests or several signals wait, the oldest one is
 * picked (a Request by when its session was last active, a signal by when it
 * was raised), so the row does not change when a newer one arrives.
 *
 * A Request counts when its session belongs to any live run of the Task, not
 * only the newest one.
 */
const findTrackingWait = (
  task: TrackingTask,
  requests: ReadonlyArray<WaitingRunSession>,
  oldestSignalByTask: ReadonlyMap<string, Signal>,
): TrackingWait | undefined => {
  const session = requests
    .filter((request) => task.liveRunIds.includes(request.runId))
    .toSorted(
      (a, b) => a.activityAt.localeCompare(b.activityAt) || a.sessionId.localeCompare(b.sessionId),
    )[0];
  if (session !== undefined) return { kind: "request", session };
  const signal = oldestSignalByTask.get(task.taskId);
  return signal === undefined ? undefined : { kind: "signal", signal };
};

/**
 * Builds Tracking's rows from the Tasks `task.queryTracking` returns, the
 * sessions of runs that have an open Request (`requests`, see
 * `listWaitingRunSessions`) and Your work, in Tracking's order: Needs you, Failed,
 * Finished, Working, Stopped, and inside a state the oldest handoff first (see
 * `readLatestHandoffAt`).
 *
 * A Task's state, highest first:
 *
 * - Needs you: a session of any of its live runs has an open Request, or an
 *   open signal names it as Your work. It wins over what the runs say. See
 *   `findTrackingWait` for which wait a row shows.
 * - Failed: the newest run failed.
 * - Working: a run is live (pending or running), so the row reads the newest
 *   live run.
 * - Finished: no run is live, and the newest run completed.
 * - Stopped: the newest run was cancelled.
 *
 * A re-run is the newest run, so it moves a row to its own state.
 */
export const buildTrackingRows = (
  tasks: ReadonlyArray<TrackingTask>,
  requests: ReadonlyArray<WaitingRunSession>,
  yourWork: YourWork,
): ReadonlyArray<TrackingRow> => {
  const oldestSignalByTask = indexOldestSignalByTask(yourWork);
  return tasks
    .map((task): TrackingRow => {
      const run =
        task.latestRun.status !== "failed" && task.latestLiveRun !== undefined
          ? task.latestLiveRun
          : task.latestRun;
      const waitsOn = findTrackingWait(task, requests, oldestSignalByTask);
      if (waitsOn !== undefined) {
        const since =
          waitsOn.kind === "request" ? waitsOn.session.activityAt : waitsOn.signal.createdAt;
        return { task, state: "needs-you", waitsOn, run, since };
      }
      const state = decideTrackingState(run);
      return { task, state, run, since: readStateStart(run) };
    })
    .toSorted(
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
 * Checks whether a row in `state` waits on the user: Needs you, Failed and
 * Finished do, Working and Stopped never do. Waiting rows count toward To do.
 */
export const isTrackingStateWaitingOnUser = (state: TrackingState): boolean =>
  state === "needs-you" || state === "failed" || state === "finished";

/**
 * Returns how many of `rows` wait on the user. It is the "N wait on you" of
 * Tracking's head, and what Tracking adds to the To do count.
 */
export const countWaitingTrackingRows = (rows: ReadonlyArray<TrackingRow>): number =>
  rows.filter((row) => isTrackingStateWaitingOnUser(row.state)).length;

/**
 * Checks whether a row in `state` can be marked done: the work has stopped, so
 * ticking it off leaves no run going. A Working row cannot, because marking it
 * done would leave its run running. A Needs you row cannot either: it may be
 * waiting on a Request of a live run.
 */
export const canMarkTrackingStateDone = (state: TrackingState): boolean =>
  state !== "working" && state !== "needs-you";

/**
 * Checks whether a push on the `run` topic can change the `task.queryTracking`
 * read behind Tracking, so it must be read again. A Request or a signal that
 * starts or stops waiting is not a run push: the app rebuilds the rows from
 * them (`buildTrackingRows`) without this read. `push` is the push's `ids` and
 * `kind`. It can when:
 *
 * - it lists no ids, which means every run may have changed;
 * - it names the newest run, or any live run, of one of `tasks`, whatever
 *   happened to it. An older live run counts because its end changes which
 *   Requests the row waits on;
 * - it is the creation of a run, because a re-run keeps its Task's id and
 *   starts a run no row holds yet, and a re-run makes no `task` push.
 *
 * Every other run, such as one a cron fire started, leaves Tracking as it is.
 */
export const isTrackingAffectedByRunPush = (
  tasks: ReadonlyArray<TrackingTask>,
  push: { readonly ids: ReadonlyArray<string>; readonly kind: "created" | "updated" | "deleted" },
): boolean =>
  push.ids.length === 0 ||
  push.kind === "created" ||
  tasks.some(
    (task) =>
      push.ids.includes(task.latestRun.id) ||
      (task.latestLiveRun !== undefined && push.ids.includes(task.latestLiveRun.id)) ||
      task.liveRunIds.some((runId) => push.ids.includes(runId)),
  );

/**
 * Returns the pose of the face that stands for `row` in the pane: the pose of
 * its state, except that a row waiting on a signal shows the agent as its last
 * run left it, `failed` or `done`, because the agent itself asks nothing.
 */
export const decideTrackingRowPose = (row: TrackingRow): Pose => {
  if (row.state === "needs-you" && row.waitsOn.kind === "signal") {
    return row.run.status === "failed" ? "failed" : "done";
  }
  return decideTrackingStatePose(row.state);
};

/**
 * The line under a row's title. The renderer draws `workflowName` in the
 * workflow's hue, then a space, then `text`. A line with no `workflowName`
 * is `text` alone.
 */
export interface TrackingLine {
  /** The name of the workflow that has the work, or null on a Needs you row, whose line says what waits. */
  readonly workflowName: string | null;
  /**
   * What follows the workflow's name, with its own separator: "failed ·
   * reason", "finished", "· working". With no workflow name it is the whole
   * line: "Run git push?", "Checks failed on payments-api #1302".
   */
  readonly text: string;
}

/**
 * Describes the line under a row's title:
 *
 * - Needs you, with no workflow name because the line says what waits. By a
 *   Request it is the Request's question, such as "Run git push?". By a signal
 *   it is "<Kind> on <place>", such as "Checks failed on payments-api #1302",
 *   or the kind alone when the signal has no place.
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
  if (row.state === "needs-you") {
    const { waitsOn } = row;
    if (waitsOn.kind === "request") return { workflowName: null, text: waitsOn.session.question };
    const { kind, place } = waitsOn.signal;
    return {
      workflowName: null,
      text: place === undefined ? nameSignalKind(kind) : `${nameSignalKind(kind)} on ${place}`,
    };
  }
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

/** Where opening a row of Tracking goes. */
export type TrackingRowDestination =
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "thread"; readonly sessionId: string }
  | { readonly kind: "signal"; readonly signalId: string };

/**
 * Decides where opening `row` goes. A Needs you row goes to what waits on the
 * user, because that is what the user came to answer:
 *
 * - by a Request, the thread of the session that asks;
 * - by a signal, that signal in Intake's To do.
 *
 * A row in any other state goes to the page of its run.
 */
export const decideTrackingRowDestination = (row: TrackingRow): TrackingRowDestination => {
  if (row.state !== "needs-you") return { kind: "run", runId: row.run.id };
  return row.waitsOn.kind === "request"
    ? { kind: "thread", sessionId: row.waitsOn.session.sessionId }
    : { kind: "signal", signalId: row.waitsOn.signal.id };
};
