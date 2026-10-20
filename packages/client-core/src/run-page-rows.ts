/**
 * What a run's page shows above and beside its graph (spec 17 §Workflows,
 * "A run's page"): the lead, the earlier-version note, and the step timeline.
 *
 * This module is the subpath `@hercule/client-core/run-page-rows`, not part
 * of the index, so that it stays off the desktop app's first screen.
 */
import type { Run, Session, TriggerFiresOn, Workflow } from "@hercule/contract";
import { decideStepRunState, type NodeRunState } from "./graph-model";
import { formatValueOnOneLine } from "./node-details";
import {
  describeFailureReason,
  describeRunOrigin,
  isRunLive,
  listAwaitedSignals,
  readTimestamps,
  type StepLineKind,
  type WorkState,
} from "./run-display";
import { buildLiveTimeAxis, buildStepLines, buildTimeline, type TimelineTick } from "./run-graph";
import {
  decideRunMarkState,
  describeWaitingRunSession,
  type RunMarkState,
  type RunPlace,
} from "./run-marks";
import { decideFiresOn } from "./trigger-display";
import { listWaitingRunSessions } from "./waiting";

/** One row of the lead's values: an input, or the output. */
export interface RunValueRow {
  readonly name: string;
  /** The value on one line (`formatValueOnOneLine`): a string as it is, any other value as JSON. */
  readonly value: string;
}

/** What a run's page leads with. */
export interface RunLead {
  /** The run's mark, as the Runs tab draws it. */
  readonly mark: RunMarkState;
  /** "Waiting on you", "Starting", "Running", "Completed", "Failed" or "Cancelled". */
  readonly stateText: string;
  /**
   * What the run asks the user, "security asks: Run npm audit fix?", and the
   * session to answer it in. `undefined` unless the run waits on the user.
   */
  readonly ask: { readonly question: string; readonly sessionId: string } | undefined;
  /** Why the run failed: "Iteration limit at count. <the message>". `undefined` unless it failed. */
  readonly failure: string | undefined;
  /**
   * Who or what started the run, after "Started by", and how, as the web run
   * page's header reads: a trigger's id with the event it matched, "labeled
   * on github.issue.labeled", with whether the trigger fires on a schedule or
   * on events; or the actor, "you" or "you through the API", with `firesOn`
   * null.
   */
  readonly startedBy: { readonly text: string; readonly firesOn: TriggerFiresOn | null };
  /** The inputs the run started with, in the order its plan declares them, then any other. */
  readonly inputs: ReadonlyArray<RunValueRow>;
  /** The run's output, named "Output", or `undefined` when it has none. */
  readonly output: RunValueRow | undefined;
}

/** The words of each mark a run's lead can have. */
const STATE_TEXTS: Readonly<Record<RunMarkState, string>> = {
  waiting: "Waiting on you",
  starting: "Starting",
  working: "Running",
  done: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/**
 * Returns the words for a run's `mark`: "Waiting on you", "Starting",
 * "Running", "Completed", "Failed" or "Cancelled". A run's page leads with
 * them, and a step session's header names its run's link with them, because
 * the mark alone is a picture.
 */
export const describeRunState = (mark: RunMarkState): string => STATE_TEXTS[mark];

/**
 * Reads where `run` is, as its mark needs it: while it runs, the steps whose
 * records are running or pending, and the signals it waits for. A running
 * run with neither is between starting and its first step.
 */
const readRunPlace = (run: Run): RunPlace =>
  run.status === "running"
    ? {
        status: "running",
        activeStepIds: run.steps
          .filter((record) => record.status === "running" || record.status === "pending")
          .map((record) => record.stepId),
        awaitedSignalIds: listAwaitedSignals(run),
      }
    : run;

/**
 * The workflow a run's crumb leads back to: one the user can open, or the
 * name of one that is gone, with why there is no page to open: "not saved"
 * when the run was started from a workflow that was never saved, or
 * "deleted".
 */
export type RunCrumbWorkflow =
  | { readonly kind: "saved"; readonly workflowId: string; readonly name: string }
  | { readonly kind: "gone"; readonly name: string; readonly reason: "not saved" | "deleted" };

/**
 * Names the workflow `run`'s crumb leads back to. The name is the one in
 * the run's plan, so it is known even after the workflow is deleted.
 * `isWorkflowDeleted` is whether reading the run's workflow failed as not
 * found.
 */
export const describeRunWorkflow = (
  run: Pick<Run, "workflowId" | "plan">,
  isWorkflowDeleted: boolean,
): RunCrumbWorkflow => {
  if (run.workflowId === null) return { kind: "gone", name: run.plan.name, reason: "not saved" };
  if (isWorkflowDeleted) return { kind: "gone", name: run.plan.name, reason: "deleted" };
  return { kind: "saved", workflowId: run.workflowId, name: run.plan.name };
};

/**
 * Finds the session of `run` that waits on the user, the most recently
 * active one when several do. Returns `undefined` for a run that is not
 * live, or none of whose `sessions` has an open Request.
 */
const findWaitingSession = (run: Run, sessions: ReadonlyArray<Session>) =>
  isRunLive(run.status)
    ? listWaitingRunSessions(sessions).find((session) => session.runId === run.id)
    : undefined;

/**
 * Returns `run`'s mark, as the lead of its page and a session's header draw
 * it. `sessions` are sessions that may belong to the run; a live run with one
 * that has an open Request waits on the user.
 */
export const decideRunMark = (run: Run, sessions: ReadonlyArray<Session>): RunMarkState =>
  decideRunMarkState(readRunPlace(run), findWaitingSession(run, sessions) !== undefined);

/**
 * Returns what went wrong in a failed run, in a sentence from the run's
 * records: its `failureMessage`, else the message of the edge it failed at,
 * else the error of the failed step's latest failed record. Returns
 * `undefined` for a run that did not fail, or that failed with none of these
 * (a workspace failure, for instance).
 */
export const findFailureMessage = (run: Run): string | undefined => {
  if (run.status !== "failed") return undefined;
  if ("failureMessage" in run) return run.failureMessage;
  if ("failedEdge" in run && run.failedEdge !== undefined) return run.failedEdge.message;
  const stepId = "failedStepId" in run ? run.failedStepId : undefined;
  return run.steps
    .filter((record) => record.stepId === stepId)
    .findLast((record) => record.status === "failed")?.error.message;
};

/**
 * Describes why a failed run failed, in one line: the reason and the step,
 * then what went wrong (`findFailureMessage`): "Iteration limit at count. The
 * run would follow count → file a fourth time." Returns `undefined` for a run
 * that did not fail.
 */
const describeRunFailure = (run: Run): string | undefined => {
  if (run.status !== "failed") return undefined;
  const reason = describeFailureReason(run.failureReason);
  const capitalized = reason.charAt(0).toUpperCase() + reason.slice(1);
  const stepId = "failedStepId" in run ? run.failedStepId : undefined;
  const headline = stepId === undefined ? capitalized : `${capitalized} at ${stepId}`;
  const message = findFailureMessage(run);
  return message === undefined ? headline : `${headline}. ${message}`;
};

/** Builds a value row, with the value on one line. */
const buildValueRow = (name: string, value: unknown): RunValueRow => ({
  name,
  value: formatValueOnOneLine(value).text,
});

/** Lists the inputs `run` started with, in the order its plan declares them, then any other in their own order. */
const listInputRows = (run: Run): ReadonlyArray<RunValueRow> => {
  const order = (run.plan.inputs ?? []).map((input) => input.name);
  const rank = (name: string): number => {
    const index = order.indexOf(name);
    return index === -1 ? order.length : index;
  };
  return Object.entries(run.inputs)
    .toSorted(([a], [b]) => rank(a) - rank(b))
    .map(([name, value]) => buildValueRow(name, value));
};

/**
 * Builds the lead of `run`'s page. `sessions` are the run's sessions: a live
 * run with a session that has an open Request waits on the user, and its
 * lead asks what that session asks. With several, it asks what the most
 * recently active one asks, as Waiting on you does.
 */
export const buildRunLead = (run: Run, sessions: ReadonlyArray<Session>): RunLead => {
  const waiting = findWaitingSession(run, sessions);
  const mark = decideRunMark(run, sessions);
  const { origin } = run;
  const on =
    origin.kind === "trigger"
      ? run.plan.triggers?.find((trigger) => trigger.id === origin.triggerId)?.on
      : undefined;
  const reading = describeRunOrigin(run);
  // A trigger is named by its id alone, as the book's chip draws it: the
  // event that fired it has a list of its own on the page. An actor is
  // followed by how the run started, such as "through the API", as in the
  // web run page's header.
  const startedByText =
    reading.kind === "trigger"
      ? reading.triggerId
      : reading.howStarted === undefined
        ? reading.label
        : `${reading.label} ${reading.howStarted}`;
  return {
    mark,
    stateText: describeRunState(mark),
    ask:
      waiting === undefined
        ? undefined
        : { question: describeWaitingRunSession(waiting), sessionId: waiting.sessionId },
    failure: describeRunFailure(run),
    startedBy: { text: startedByText, firesOn: on === undefined ? null : decideFiresOn(on) },
    inputs: listInputRows(run),
    output:
      run.status === "completed" && run.output !== undefined
        ? buildValueRow("Output", run.output)
        : undefined,
  };
};

/**
 * Checks whether `run` followed an earlier version of `workflow`: the
 * workflow's text changed after the run was created. Turning a workflow on or
 * off does not move its `updatedAt`, so only a change to its text counts; a
 * text changed and changed back counts too, because the page does not parse
 * the workflow to compare.
 */
export const ranOnEarlierVersion = (
  run: Pick<Run, "createdAt">,
  workflow: Pick<Workflow, "updatedAt">,
): boolean => Date.parse(workflow.updatedAt) > Date.parse(run.createdAt);

/** One row of a run's step timeline: a step record, or a plan step the run has not reached. */
export interface StepTimelineRow {
  /** Unique within the run. */
  readonly key: string;
  /** The id of the step, or of the signal trigger that fired. */
  readonly stepId: string;
  /** What the row's step is: an action or an agent step, or a signal trigger. */
  readonly kind: StepLineKind;
  /** `#2` on each row of a step the run came to more than once. */
  readonly iterationLabel: string | undefined;
  /** Where the run is at the row, which picks its mark. `unreached`, `pending`, `skipped` and `cancelled` draw none. */
  readonly state: NodeRunState;
  /**
   * The bar of a record that started, as fractions of the axis. `end` is
   * `undefined` for the bar of a live run's running record, which ends at
   * now: the screen draws its end on the age clock.
   */
  readonly bar: { readonly start: number; readonly end: number | undefined } | undefined;
  /** What a row with no bar shows at the start of its track (`describeTrackNote`), such as "Waiting to start". */
  readonly note: string | undefined;
  readonly startedAt: string | undefined;
  readonly finishedAt: string | undefined;
  /** The session the record drives, which the row opens. */
  readonly sessionId: string | undefined;
  /** Why the step failed, for a failed record. */
  readonly errorText: string | undefined;
}

/** A run's steps on a time axis. */
export interface StepTimeline {
  /** Where the axis starts: when the run started, or was created when it never started. */
  readonly originAt: string;
  /** How long the axis is, in milliseconds. */
  readonly spanMs: number;
  readonly ticks: ReadonlyArray<TimelineTick>;
  readonly rows: ReadonlyArray<StepTimelineRow>;
}

/**
 * Returns what the timeline shows at the start of the track of a step record
 * or plan step in `state` that has no bar, as the Bureau book draws it:
 *
 * - "Waiting to start" for a record that is queued;
 * - "skipped" for one whose condition was false;
 * - "cancelled before it started" for one the run's cancel reached first.
 *
 * Returns `undefined` for every other state. A plan step the run has not
 * reached shows nothing on its track, because its muted name already says so.
 */
const describeTrackNote = (state: WorkState): string | undefined => {
  switch (state) {
    case "pending":
      return "Waiting to start";
    case "skipped":
      return "skipped";
    case "cancelled":
      return "cancelled before it started";
    case "unreached":
    case "running":
    case "completed":
    case "failed":
      return undefined;
  }
};

/**
 * Returns where `run`'s step timeline ends at `now`, in milliseconds since the
 * epoch, on an axis `axisWidthInCharacters` characters of its labels wide:
 *
 * - while the run is live, at the first tick at or after now
 *   (`buildLiveTimeAxis`), so the value changes only when now passes it;
 * - once the run has ended, where it ended.
 *
 * `buildStepTimeline` builds the same timeline at this instant as at `now`.
 * A screen keeps the instant current on the age clock, which costs one axis
 * per tick, and builds the timeline again only when the instant changes.
 */
export const computeStepTimelineEnd = (
  run: Run,
  now: number,
  axisWidthInCharacters: number,
): number => {
  const { startedAt, finishedAt } = readTimestamps(run);
  if (!isRunLive(run.status)) return finishedAt === undefined ? now : Date.parse(finishedAt);
  const origin = Date.parse(startedAt ?? run.createdAt);
  return origin + buildLiveTimeAxis(now - origin, axisWidthInCharacters).spanMs;
};

/**
 * Counts the rows of `run`'s step timeline (`buildStepTimeline`) without
 * placing them on an axis: one per step record, and one per plan step the
 * run has not reached.
 */
export const countStepTimelineRows = (run: Run): number => buildStepLines(run).length;

/**
 * Builds `run`'s step timeline at `now` (milliseconds since the epoch), on an
 * axis `axisWidthInCharacters` characters of its labels wide: one row per step
 * record, in the order they were created, then one per plan step the run has
 * not reached (`buildTimeline`). `sessions` are the run's sessions: a running
 * record whose session has an open Request is `waiting`.
 *
 * Once the run has ended, the axis ends where the run ended. While it is
 * live, the axis ends at the first tick at or after now (`buildLiveTimeAxis`),
 * so the axis, its ticks and every bar but the running ones stay the same
 * until now passes the axis's end. The running bars' ends are left to the
 * screen, which moves them on the age clock.
 */
export const buildStepTimeline = (
  run: Run,
  sessions: ReadonlyArray<Session>,
  now: number,
  axisWidthInCharacters: number,
): StepTimeline => {
  const { startedAt } = readTimestamps(run);
  const originAt = startedAt ?? run.createdAt;
  const origin = Date.parse(originAt);
  const isLive = isRunLive(run.status);
  const liveAxis = isLive ? buildLiveTimeAxis(now - origin, axisWidthInCharacters) : undefined;
  // On a live run's axis, the timeline is built as if now were the axis's
  // end, so every bar is measured against the axis's length.
  const timeline = buildTimeline(
    run,
    liveAxis === undefined ? now : origin + liveAxis.spanMs,
    axisWidthInCharacters,
  );
  const askingSessionIds = new Set(
    sessions.filter((session) => session.openRequests.length > 0).map((session) => session.id),
  );
  return {
    originAt,
    spanMs: liveAxis?.spanMs ?? Math.max(1, timeline.elapsedMs),
    ticks: liveAxis?.ticks ?? timeline.ticks,
    rows: timeline.lines.map(({ line, bar }): StepTimelineRow => {
      const sessionId = line.session?.id;
      return {
        key: line.key,
        stepId: line.stepId,
        kind: line.kind,
        iterationLabel: line.iterationLabel,
        state: decideStepRunState(line.state, askingSessionIds.has(sessionId ?? "")),
        bar:
          bar === undefined
            ? undefined
            : {
                start: bar.start,
                end: isLive && line.finishedAt === undefined ? undefined : bar.end,
              },
        // A cancelled record that started has a bar, and so no note.
        note: line.startedAt === undefined ? describeTrackNote(line.state) : undefined,
        startedAt: line.startedAt,
        finishedAt: line.finishedAt,
        sessionId,
        errorText: line.error?.message,
      };
    }),
  };
};
