/**
 * How a run and its steps are described on screen: who started the run, the
 * words for its status and its failure, and how long it and its steps took.
 *
 * The rules live here with a test rather than inside a component, so the run
 * list and a run's page use the same words for a run's status and failure.
 * The page says more than the list in one place: for a run that failed at an
 * edge, the list names only the failed step, and the page also names the
 * edge, because only the page has the run's plan.
 */
import type { FailureReason, Run, RunOrigin, RunStatus, StepStatus } from "@hercule/contract";
import { describeActor, type ActorReading } from "./actor-display";
import { formatDuration } from "./threads/duration";

/**
 * Where a run or one step of its plan is: its status, or for a step with no
 * step record `unreached`, because the run has not got there yet or never
 * will. `@hercule/ui` spells the same union under the same name for its
 * state marks, because it depends on no Hercule package; the two meet
 * wherever a screen passes one to the other, so the type checker keeps
 * them equal.
 */
export type WorkState = StepStatus | "unreached";

/** Checks whether a run can still change: it is pending or running. */
export const isRunLive = (status: RunStatus): boolean =>
  status === "pending" || status === "running";

/**
 * Checks whether a run recedes in a list: it completed or was cancelled, so
 * the runs still going and the runs that failed stand out.
 */
export const shouldRunRecede = (status: RunStatus): boolean =>
  status === "completed" || status === "cancelled";

/** Who started a run, and how, if not by hand. */
export interface RunOriginReading {
  /** The user or a session, or for a run a `run.start` step started, the parent run. */
  readonly starter: ActorReading;
  /**
   * How the run was started when that was not by hand: "through the API",
   * or "at step <id>" for a run another run's step started.
   */
  readonly howStarted: string | undefined;
}

/**
 * Returns who started a run and how. A run started through the API reads
 * differently from one started by hand, even when the user started both,
 * because a workflow sent with the request is stored nowhere.
 */
export const describeRunOrigin = (origin: RunOrigin): RunOriginReading => {
  switch (origin.kind) {
    case "manual":
      return { starter: describeActor(origin.actor), howStarted: undefined };
    case "api":
      return { starter: describeActor(origin.actor), howStarted: "through the API" };
    case "action":
      // The run that started this one stamps its writes `run:<id>`.
      return {
        starter: describeActor(`run:${origin.parentRunId}`),
        howStarted: `at step ${origin.stepId}`,
      };
  }
};

/** When a run or a step record started and finished. Each is absent until it has happened. */
export interface Timestamps {
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

/**
 * A run or a run summary, reduced to the fields its times follow from. The
 * contract gives each status only the times it can have.
 */
type TimedRun =
  | { readonly status: "pending" }
  | { readonly status: "running"; readonly startedAt: string }
  | {
      readonly status: "completed" | "failed" | "cancelled";
      readonly startedAt?: string;
      readonly finishedAt: string;
    };

/**
 * A run, a run summary or a step record, reduced to the fields its times
 * follow from. Only a step record can be skipped.
 */
type TimedRecord = TimedRun | { readonly status: "skipped"; readonly finishedAt: string };

/**
 * Returns when a run, a run summary or a step record started and finished,
 * by its status:
 *
 * - `pending`: neither.
 * - `running`: `startedAt`.
 * - `completed`, `failed` and `cancelled`: `finishedAt`, and `startedAt` when
 *   it had started. A run cancelled before it started, or one the controller
 *   could not start, has none.
 * - `skipped`: `finishedAt`. A skipped step record never started.
 */
export const readTimestamps = (record: TimedRecord): Timestamps => {
  switch (record.status) {
    case "pending":
      return {};
    case "running":
      return { startedAt: record.startedAt };
    case "completed":
    case "failed":
    case "cancelled":
      return {
        ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
        finishedAt: record.finishedAt,
      };
    case "skipped":
      return { finishedAt: record.finishedAt };
  }
};

/**
 * Returns how long something took from `startedAt` to `finishedAt`, in
 * milliseconds, or up to `now` while it has not finished. Returns `undefined`
 * when it has not started.
 */
export const measureElapsed = (
  startedAt: string | undefined,
  finishedAt: string | undefined,
  now: number,
): number | undefined => {
  if (startedAt === undefined) return undefined;
  const end = finishedAt === undefined ? now : Date.parse(finishedAt);
  return Math.max(0, end - Date.parse(startedAt));
};

/**
 * Formats an elapsed time: `12ms` below a second, `4.3s` below a minute,
 * and `1m 4s` or `1h 4m` above. Every unit is rounded down, so a ticking
 * time never shows a moment that has not passed. An action step often takes a few
 * milliseconds, so a coarser format would show every step as `0s`.
 */
export const formatElapsed = (ms: number): string => {
  if (ms < 1000) return `${String(Math.floor(ms))}ms`;
  if (ms < 60_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  return formatDuration(Math.floor(ms / 1000) * 1000);
};

/**
 * Returns how long a step ran, or has run up to `now` while it runs, such as
 * `40ms` or `1m 15s`, or an empty string for a step that has not started. The
 * web app and the CLI both show a step's duration with it, so the two never
 * disagree about the same step record.
 */
export const describeStepDuration = (times: Timestamps, now: number): string => {
  const elapsed = measureElapsed(times.startedAt, times.finishedAt, now);
  return elapsed === undefined ? "" : formatElapsed(elapsed);
};

/**
 * Returns the words for a run's status as a run's page shows them, with the
 * run's duration: "pending", "running 4.3s", "completed in 23ms", "failed
 * after 1.2s", "cancelled after 4.1s". A run cancelled before it started has
 * no duration and is just "cancelled".
 */
export const describeRunStatus = (run: TimedRun, now: number): string => {
  const { startedAt, finishedAt } = readTimestamps(run);
  const elapsed = measureElapsed(startedAt, finishedAt, now);
  if (run.status === "pending" || elapsed === undefined) return run.status;
  const duration = formatElapsed(elapsed);
  switch (run.status) {
    case "running":
      return `running ${duration}`;
    case "completed":
      return `completed in ${duration}`;
    case "failed":
      return `failed after ${duration}`;
    case "cancelled":
      return `cancelled after ${duration}`;
  }
};

/**
 * Returns a failure reason in a few plain words: "step failed", "expression
 * error" for a template or a condition that could not be evaluated,
 * "iteration limit" for an edge the run was to follow more often than its
 * `maxTraversals` allows, or "controller error" for a run the controller
 * could not carry out.
 */
export const describeFailureReason = (reason: FailureReason): string => {
  switch (reason) {
    case "step-failed":
      return "step failed";
    case "expression-error":
      return "expression error";
    case "iteration-limit":
      return "iteration limit";
    case "controller-error":
      return "controller error";
  }
};

/** An edge of a run's plan, as the workflow definition spells it. */
type PlanEdge = NonNullable<Run["plan"]["edges"]>[number];

/**
 * Returns the edge of the plan a failed run failed at: the edge whose
 * `maxTraversals` it reached, or whose condition could not be evaluated.
 * Returns `undefined` for a run that did not fail, or that failed at a step
 * rather than at an edge.
 */
export const findFailedEdge = (run: Run): PlanEdge | undefined =>
  "failedEdge" in run && run.failedEdge !== undefined
    ? run.plan.edges?.[run.failedEdge.index]
    : undefined;

/**
 * Returns the text the timeline shows where a step with no bar would be:
 * - "pending" for a step waiting to start;
 * - "cancelled before it started" for one the run's cancel reached first;
 * - "skipped" for one whose condition was false;
 * - "not reached" for a step the run ended without reaching.
 *
 * Returns `undefined` for a step with a bar, and for a step a live run has
 * not reached yet, because the run may still reach it.
 */
export const describeUnstartedStep = (
  state: WorkState,
  runStatus: RunStatus,
): string | undefined => {
  switch (state) {
    case "pending":
    case "skipped":
      return state;
    case "cancelled":
      return "cancelled before it started";
    case "unreached":
      return isRunLive(runStatus) ? undefined : "not reached";
    case "running":
    case "completed":
    case "failed":
      return undefined;
  }
};

/**
 * Returns the word for a step's state: its status as the contract spells it,
 * the same word the run list and the CLI use, and for a step with no step
 * record "not started" while the run is live and "not reached" once it has
 * ended.
 */
export const describeStepState = (state: WorkState, runStatus: RunStatus): string =>
  state !== "unreached" ? state : isRunLive(runStatus) ? "not started" : "not reached";
