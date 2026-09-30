/**
 * How a run and its steps are described on screen: who started the run, the
 * words for its status and its failure, how long it and its steps took, and
 * how it can be re-run and which runs re-ran it.
 *
 * The rules live here with a test rather than inside a component, so the run
 * list and a run's page use the same words for a run's status and failure.
 * The page says more than the list in one place: for a run that failed at an
 * edge, the list names only the failed step, and the page also names the
 * edge, because only the page has the run's plan.
 */
import type {
  FailureReason,
  RerunMode,
  Run,
  RunOrigin,
  RunStatus,
  Runner,
  StepStatus,
  TriggerEvent,
  WorkflowAction,
} from "@hercule/contract";
import { describeActor, type ActorReading, type ActorTarget } from "./actor-display";
import { formatDuration } from "./threads/duration";
import { formatStamp } from "./time-context";

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

/** One way to re-run a run, as the question before a re-run offers it. */
export interface RerunChoice {
  readonly mode: RerunMode;
  /** The words on the choice, such as "As it ran". */
  readonly label: string;
  /** One sentence on what the new run will do, shown under the choice. */
  readonly explanation: string;
}

/**
 * Returns the ways an ended run can be re-run, the default first, so the
 * list is never empty. Both start the new run with the original run's inputs:
 *
 * - `re-stamp`, "From the current workflow": the workflow as it is saved now.
 *   This is the default, because a re-run usually follows a fix to the
 *   workflow.
 * - `replay`, "As it ran": the plan the original run froze when it started.
 *
 * A run with no saved workflow to start from offers only `replay`, with an
 * explanation that says why. That is a run of a workflow sent with
 * `run.start`, and a run whose workflow was deleted since, which the run
 * itself cannot tell: pass `isWorkflowDeleted` as true when reading the run's
 * workflow failed with `not_found`. The controller refuses `re-stamp` for
 * both.
 */
export const listRerunChoices = (
  run: Pick<Run, "workflowId">,
  isWorkflowDeleted: boolean,
): readonly [RerunChoice, ...RerunChoice[]] => {
  if (run.workflowId === null) {
    return [
      {
        mode: "replay",
        label: "As it ran",
        explanation:
          "This run's workflow was sent with the run and never saved, so the new run follows this run's plan, as it was frozen when the run started.",
      },
    ];
  }
  if (isWorkflowDeleted) {
    return [
      {
        mode: "replay",
        label: "As it ran",
        explanation:
          "This run's workflow was deleted, so the new run follows this run's plan, as it was frozen when the run started.",
      },
    ];
  }
  return [
    {
      mode: "re-stamp",
      label: "From the current workflow",
      explanation: "The new run follows the workflow as it is saved now.",
    },
    {
      mode: "replay",
      label: "As it ran",
      explanation: "The new run follows this run's plan, as it was frozen when the run started.",
    },
  ];
};

/** How many of a run's re-runs its header links to. */
const SHOWN_RERUN_COUNT = 3;

/** The re-runs of a run, as its header shows them. */
export interface RerunsReading {
  /** The ids of the newest re-runs, newest first, at most three. */
  readonly runIds: ReadonlyArray<string>;
  /**
   * How many re-runs are not linked, such as "2 more". When the page read
   * has a next page, the count is a lower bound, such as "47+ more", or just
   * "more" when every re-run on the page is linked. `undefined` when every
   * re-run is linked.
   */
  readonly unlinkedCountText: string | undefined;
}

/**
 * Returns the re-runs a run's header links to: the newest three of one page
 * of `run.query` with `originalRunId`, which lists them newest first, and how
 * many more there are. A run rarely has more than a few re-runs, so the header
 * counts the rest instead of listing them, and reads only the first page.
 */
export const describeReruns = (page: {
  readonly items: ReadonlyArray<{ readonly id: string }>;
  readonly nextCursor?: string;
}): RerunsReading => {
  const runIds = page.items.slice(0, SHOWN_RERUN_COUNT).map((rerun) => rerun.id);
  const unlinkedCount = page.items.length - runIds.length;
  return { runIds, unlinkedCountText: describeUnlinkedCount(unlinkedCount, page.nextCursor) };
};

/**
 * Returns the words for the re-runs a run's header does not link, or
 * `undefined` when there are none. `unlinkedCount` counts the ones on the page
 * read; a next page means there are more than that.
 */
const describeUnlinkedCount = (
  unlinkedCount: number,
  nextCursor: string | undefined,
): string | undefined => {
  if (nextCursor === undefined) {
    return unlinkedCount === 0 ? undefined : `${String(unlinkedCount)} more`;
  }
  return unlinkedCount === 0 ? "more" : `${String(unlinkedCount)}+ more`;
};

/**
 * Who or what started a run, and how:
 *
 * - `actor`: the user, a session, or for a run a `run.start` step started,
 *   the parent run. `link` is where its label links to.
 * - `trigger`: a start trigger of the run's workflow, which is not an actor:
 *   it acts for nobody and links nowhere.
 *
 * `label` names the starter in a few words, as the run list shows it after
 * "by": "you", "session 7c82ebeb", "run 1f3a9c2e", "trigger weekday_morning".
 * `howStarted` follows the label when the run was not started by hand:
 * "through the API", "at step spawn" for a run another run's step started, or
 * "on github.issue.opened" for the kind of event a trigger matched. A trigger
 * run's summary holds no copy of the event, so it has no `howStarted`.
 */
export type RunOriginReading =
  | {
      readonly kind: "actor";
      readonly label: string;
      readonly link: ActorTarget;
      readonly howStarted: string | undefined;
    }
  | {
      readonly kind: "trigger";
      readonly label: string;
      /** The trigger's id in the workflow's source. */
      readonly triggerId: string;
      readonly howStarted: string | undefined;
    };

/**
 * Returns who or what started a run, and how. A run started through the API
 * reads differently from one started by hand, even when the user started
 * both, because a workflow sent with the request is stored nowhere. Takes a
 * run or a run summary; only a run holds the event a trigger matched.
 */
export const describeRunOrigin = (run: {
  readonly origin: RunOrigin;
  readonly triggerEvent?: Pick<TriggerEvent, "kind">;
}): RunOriginReading => {
  const { origin } = run;
  switch (origin.kind) {
    case "manual":
      return buildActorOriginReading(describeActor(origin.actor), undefined);
    case "api":
      return buildActorOriginReading(describeActor(origin.actor), "through the API");
    case "action":
      // The run that started this one stamps its writes `run:<id>`.
      return buildActorOriginReading(
        describeActor(`run:${origin.parentRunId}`),
        `at step ${origin.stepId}`,
      );
    case "trigger":
      return {
        kind: "trigger",
        label: `trigger ${origin.triggerId}`,
        triggerId: origin.triggerId,
        howStarted: run.triggerEvent === undefined ? undefined : `on ${run.triggerEvent.kind}`,
      };
  }
};

/** Builds the origin reading of a run that `starter` started, `howStarted` if not by hand. */
const buildActorOriginReading = (
  starter: ActorReading,
  howStarted: string | undefined,
): RunOriginReading => ({ kind: "actor", label: starter.label, link: starter.link, howStarted });

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
 * Returns a failure reason in a few plain words: "step failed", "validation
 * error" for a run a trigger could not start because its workflow or the
 * inputs mapped from the event did not validate, "expression error" for a
 * template or a condition that could not be evaluated,
 * "iteration limit" for an edge the run was to follow more often than its
 * `maxTraversals` allows, "controller error" for a run the controller
 * could not carry out, or "workspace failed" for a run whose workspace could
 * not be set up or was lost with its runner.
 */
export const describeFailureReason = (reason: FailureReason): string => {
  switch (reason) {
    case "validation-error":
      return "validation error";
    case "step-failed":
      return "step failed";
    case "expression-error":
      return "expression error";
    case "iteration-limit":
      return "iteration limit";
    case "controller-error":
      return "controller error";
    case "workspace-failed":
      return "workspace failed";
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

/** The steps of a run that wait for a runner, and the line each of them shows. */
export interface RunnerWait {
  /**
   * The ids of the steps that wait: the running workspace steps of a run
   * whose runner is offline, or the pending workspace steps of a run that no
   * runner has taken yet.
   */
  readonly stepIds: ReadonlySet<string>;
  /**
   * "Waiting for runner mac-mini to reconnect (offline since 25 Sep 14:02)",
   * or "Waiting for a runner that can run git.commit".
   */
  readonly text: string;
}

/** Joins action ids the way a sentence lists them: "git.commit, git.push and git.tag". */
const ACTION_LIST_FORMAT = new Intl.ListFormat("en-GB", { type: "conjunction" });

/**
 * Returns which steps of a running run wait for a runner, and the line they
 * show, with times in `timezone`. A step waits only when its action runs in
 * the workspace, which `actions`, the action catalog, tells. A step that runs
 * on the controller, or whose action is no longer in the catalog, never
 * waits. There are two waits:
 *
 * - The run is pinned to a runner that is not online. Its running workspace
 *   steps wait for that runner without limit, because every workspace step
 *   of a run runs on the runner the run is pinned to. The line is "Waiting
 *   for runner mac-mini to reconnect (offline since 25 Sep 14:02)"; the part
 *   in brackets is left out when the runner has never been seen.
 * - The run is not pinned to a runner yet. Its first workspace step stays
 *   pending until a runner that can run every workspace action of the plan
 *   is online and free to take the run. The line names those actions:
 *   "Waiting for a runner that can run git.commit and git.push".
 *
 * Returns `undefined` when no step waits: the run is not running, its runner
 * is online, or none of its waiting steps runs in the workspace. `runner` is
 * the run's runner as last read; a runner with another id is ignored.
 */
export const describeRunnerWait = (
  run: Run,
  runner: Runner | undefined,
  actions: ReadonlyArray<Pick<WorkflowAction, "id" | "runsIn">>,
  timezone: string,
): RunnerWait | undefined => {
  if (run.status !== "running") return undefined;
  const workspaceActionIds = new Set(
    actions.filter((action) => action.runsIn === "workspace").map((action) => action.id),
  );
  const listWorkspaceStepIds = (status: StepStatus): ReadonlySet<string> =>
    new Set(
      run.steps
        .filter((record) => record.status === status)
        .map((record) => record.stepId)
        .filter((stepId) => {
          const step = run.plan.steps.find((each) => each.id === stepId);
          return step?.kind === "action" && workspaceActionIds.has(step.action);
        }),
    );

  if (run.runnerId === undefined) {
    const stepIds = listWorkspaceStepIds("pending");
    if (stepIds.size === 0) return undefined;
    const planActionIds = new Set(
      run.plan.steps.flatMap((step) =>
        step.kind === "action" && workspaceActionIds.has(step.action) ? [step.action] : [],
      ),
    );
    return {
      stepIds,
      text: `Waiting for a runner that can run ${ACTION_LIST_FORMAT.format(planActionIds)}`,
    };
  }

  if (runner === undefined || runner.id !== run.runnerId) return undefined;
  if (runner.connectivity === "online") return undefined;
  const stepIds = listWorkspaceStepIds("running");
  if (stepIds.size === 0) return undefined;
  const waiting = `Waiting for runner ${runner.name} to reconnect`;
  const since =
    runner.lastSeenAt === null ? undefined : formatStamp(new Date(runner.lastSeenAt), timezone);
  return { stepIds, text: since === undefined ? waiting : `${waiting} (offline since ${since})` };
};
