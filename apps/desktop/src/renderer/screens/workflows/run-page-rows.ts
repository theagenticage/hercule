/**
 * PROTOTYPE. Decides what a run's page shows: its lead, whether the run
 * followed an earlier version of its workflow, its inputs, and the rows of
 * its step timeline. The Workflows ticket moves it into
 * `@hercule/client-core`, beside the workflow page's rows.
 */
import {
  buildTimeline,
  describeFailureReason,
  describeRunOrigin,
  describeStepDuration,
  findOldestOpenRequest,
  formatElapsed,
  isRunLive,
  measureElapsed,
  readTimestamps,
  type StepLine,
} from "@hercule/client-core";
import type { Run, Session, WorkflowDefinition } from "@hercule/contract";
import type { MarkState } from "../../marks/mark-state";
import type { TriggerSource } from "./workflow-detail-rows";
import { describeRunRequest, formatDayAndClock, RUN_MARKS } from "./workflow-rows";

/** What a run's page leads with. */
export interface RunLead {
  readonly mark: MarkState;
  /** The run's state in a few words: "Waiting on you", "Failed", "Completed". */
  readonly title: string;
  /**
   * What the run asks the user while a step waits on them, or why the run
   * failed. `undefined` for a run that does neither.
   */
  readonly gist: { readonly text: string; readonly tone: "you" | "fail" } | undefined;
  /** The session whose Request the gist asks, to answer it in. */
  readonly askingSessionId: string | undefined;
  /**
   * Who or what started the run, after "Started by": a trigger's id, with a
   * clock or a bolt for what it fires on, or "you", or an agent's name.
   */
  readonly startedBy: { readonly source: TriggerSource | undefined; readonly text: string };
  /** When the run was created: "Today 10:31", "Yesterday 14:00", "3 Oct 14:00". */
  readonly timeText: string;
}

/** One input a run started with, as the page lists it. */
export interface InputFact {
  readonly name: string;
  /** A string as it is; any other value as JSON. */
  readonly value: string;
}

/** One line of a run's step timeline. */
export interface StepRow {
  readonly key: string;
  readonly stepId: string;
  /** `#2` on each line of a step the run came to more than once. */
  readonly iterationLabel: string | undefined;
  /** The mark before the step's id, or `undefined` for a step that did not run. */
  readonly mark: MarkState | undefined;
  /** How long the step ran, or has run so far. Empty for a step that did not start, and for a signal. */
  readonly durationText: string;
  /** Where the step's bar starts and ends, as fractions of the axis, for a step that started. */
  readonly bar: { readonly start: number; readonly end: number } | undefined;
  /** The colour of the bar: the waiting colour while it asks the user, the fail colour once it failed. */
  readonly tone: "you" | "fail" | undefined;
  /** What a step that did not start shows on its track, such as "skipped", and where. */
  readonly note: { readonly text: string; readonly position: number } | undefined;
  /** The session the step's record drives, whose transcript the row opens. */
  readonly sessionId: string | undefined;
  /** Why the step failed, for a failed step. */
  readonly errorText: string | undefined;
}

/** A run's step timeline: the axis and one row per step line. */
export interface StepTimelineRows {
  readonly ticks: ReturnType<typeof buildTimeline>["ticks"];
  /**
   * The label at the axis's end while the run is live, where the axis ends
   * at now: "now 29m 12s". `undefined` for a run that has ended.
   */
  readonly nowText: string | undefined;
  readonly rows: ReadonlyArray<StepRow>;
}

/** Returns `text` with its first letter in upper case. */
const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** The title of a run that does not wait on the user, by its status. */
const RUN_TITLES: Readonly<Record<Run["status"], string>> = {
  pending: "Starting",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/**
 * Returns why a failed run failed, in one line: the reason and the step,
 * then what went wrong, from the edge it failed at, the inputs that did not
 * validate, or the failed step's error. Returns `undefined` for a run that
 * did not fail.
 */
export const describeRunFailure = (run: Run): string | undefined => {
  if (run.status !== "failed") return undefined;
  const reason = capitalize(describeFailureReason(run.failureReason));
  const stepId = "failedStepId" in run ? run.failedStepId : undefined;
  const headline = stepId === undefined ? reason : `${reason} at ${stepId}`;
  const message =
    "failureMessage" in run
      ? run.failureMessage
      : "failedEdge" in run && run.failedEdge !== undefined
        ? run.failedEdge.message
        : run.steps.findLast(
            (record): record is Extract<typeof record, { status: "failed" }> =>
              record.status === "failed" && record.stepId === stepId,
          )?.error.message;
  return message === undefined ? headline : `${headline}. ${message}`;
};

/**
 * Builds the lead of `run`'s page from the run and `sessions`, the sessions
 * its agent steps started. A live run with a session that has an open
 * Request waits on the user, and leads with what that step asks. Times are
 * formatted in `timezone`, relative to `now`.
 */
export const buildRunLead = (
  run: Run,
  sessions: ReadonlyArray<Session>,
  timezone: string,
  now: Date,
): RunLead => {
  const isLive = isRunLive(run.status);
  const question = isLive ? describeRunRequest(run.id, sessions) : undefined;
  const asking = isLive
    ? sessions.find(
        (session) => session.runId === run.id && findOldestOpenRequest(session) !== null,
      )
    : undefined;
  const failure = describeRunFailure(run);
  const { origin } = run;
  const on =
    origin.kind === "trigger"
      ? run.plan.triggers?.find((trigger) => trigger.id === origin.triggerId)?.on
      : undefined;
  return {
    mark: question === undefined ? RUN_MARKS[run.status] : "waiting",
    title: question === undefined ? RUN_TITLES[run.status] : "Waiting on you",
    gist:
      question !== undefined
        ? { text: question, tone: "you" }
        : failure !== undefined
          ? { text: failure, tone: "fail" }
          : undefined,
    askingSessionId: asking?.id,
    startedBy:
      origin.kind === "trigger"
        ? {
            source: on === undefined ? undefined : "schedule" in on ? "schedule" : "event",
            text: origin.triggerId,
          }
        : { source: undefined, text: describeRunOrigin(run).label },
    timeText: formatDayAndClock(new Date(run.createdAt), timezone, now),
  };
};

/**
 * Returns how long `run` ran, or has run up to `now` (milliseconds since the
 * epoch): "29m 12s". Empty for a run that has not started.
 */
export const describeRunDuration = (run: Run, now: number): string => {
  const { startedAt, finishedAt } = readTimestamps(run);
  const elapsed = measureElapsed(startedAt, finishedAt, now);
  return elapsed === undefined ? "" : formatElapsed(elapsed);
};

/** Lists the inputs `run` started with, in the order its plan declares them, then any other. */
export const listInputFacts = (run: Run): ReadonlyArray<InputFact> => {
  const order = (run.plan.inputs ?? []).map((input) => input.name);
  const rank = (name: string): number => {
    const index = order.indexOf(name);
    return index === -1 ? order.length : index;
  };
  return Object.entries(run.inputs)
    .toSorted(([a], [b]) => rank(a) - rank(b))
    .map(([name, value]) => ({
      name,
      value: typeof value === "string" ? value : JSON.stringify(value),
    }));
};

/**
 * Returns `value` with every object's keys sorted and every undefined field
 * left out, so two values with the same content convert to the same JSON.
 */
const sortFields = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortFields);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, field]) => [key, sortFields(field)]),
  );
};

/**
 * Checks whether a run's `plan` is the same workflow as `definition`, the
 * workflow as it is saved now. A run freezes the workflow it starts from, so
 * a run started before the workflow last changed has a plan that differs.
 *
 * The two are compared field by field, not by `updatedAt`: turning a
 * workflow on or off changes `updatedAt` but not its definition.
 */
export const isPlanCurrent = (plan: WorkflowDefinition, definition: WorkflowDefinition): boolean =>
  JSON.stringify(sortFields(plan)) === JSON.stringify(sortFields(definition));

/**
 * The room the now label takes beyond its text, in characters of the tick
 * labels: its padding, and a gap before the tick label nearest it.
 */
const NOW_LABEL_PADDING_CHARACTERS = 4;

/** Returns the mark of a step line, or `undefined` for a line that did not run. */
const decideStepMark = (line: StepLine, isAsking: boolean): MarkState | undefined => {
  switch (line.state) {
    case "running":
      return isAsking ? "waiting" : "working";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "pending":
    case "skipped":
    case "cancelled":
    case "unreached":
      return undefined;
  }
};

/**
 * Builds `run`'s step timeline at `now` (milliseconds since the epoch): one
 * row per step record, in the order they were created, then one per step
 * the run has not reached (`buildTimeline`). `sessions` are the run's
 * sessions: a running step whose session has an open Request waits on the
 * user. The axis is `axisWidthInCharacters` characters of its labels wide,
 * which spaces its ticks; an axis not yet measured, 0 wide, has only the
 * tick at 0.
 */
export const buildStepTimelineRows = (
  run: Run,
  sessions: ReadonlyArray<Session>,
  now: number,
  axisWidthInCharacters: number,
): StepTimelineRows => {
  const timeline = buildTimeline(run, now, axisWidthInCharacters);
  const asking = new Set(
    sessions.filter((session) => session.openRequests.length > 0).map((each) => each.id),
  );
  const nowText = isRunLive(run.status) ? `now ${formatElapsed(timeline.elapsedMs)}` : undefined;
  // The now label sits at the axis's end. A tick whose label would reach
  // under it is left out, with its line, rather than drawn under the label.
  // An ended run has no now label, so it keeps the tick at the axis's end.
  const room = axisWidthInCharacters - (nowText?.length ?? 0) - NOW_LABEL_PADDING_CHARACTERS;
  const ticks =
    nowText === undefined
      ? timeline.ticks
      : timeline.ticks.filter(
          (tick) => tick.position * axisWidthInCharacters + tick.label.length / 2 <= room,
        );
  return {
    ticks,
    nowText,
    rows: timeline.lines.map(({ line, bar, note }): StepRow => {
      const isAsking = line.state === "running" && asking.has(line.session?.id ?? "");
      return {
        key: line.key,
        stepId: line.stepId,
        iterationLabel: line.iterationLabel,
        mark: decideStepMark(line, isAsking),
        durationText: describeStepDuration(line, line.kind, now),
        bar,
        tone: isAsking ? "you" : line.state === "failed" ? "fail" : undefined,
        note,
        sessionId: line.session?.id,
        errorText: line.error?.message,
      };
    }),
  };
};
