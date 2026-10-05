/**
 * How a run and its steps are described on screen: who started the run, the
 * words for its status and its failure, how long it and its steps took, and
 * how it can be re-run and which runs re-ran it. It also lists the signals a
 * running run with nothing to do waits on, and which session an agent step's
 * record drove.
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
  Session,
  SessionStatus,
  StepStatus,
  TriggerEvent,
  WorkflowAction,
} from "@hercule/contract";
import { describeActor, type ActorReading, type ActorTarget } from "./actor-display";
import { formatNameList } from "./name-list";
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

/**
 * What a step line is a line of: an action step, an agent step, or a signal
 * trigger, which has a record each time it fires.
 */
export type StepLineKind = "action" | "agent" | "signal";

/**
 * Returns what the step record with `stepId` is a record of, from the run's
 * plan: an action step, an agent step, or a signal trigger. A run writes
 * records only for its plan's steps and its signal triggers, so an id that
 * names no step of the plan is a signal trigger's.
 */
export const findStepLineKind = (plan: Pick<Run["plan"], "steps">, stepId: string): StepLineKind =>
  plan.steps.find((step) => step.id === stepId)?.kind ?? "signal";

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
 * Returns how long a step record of `kind` ran, or has run up to `now` while
 * it runs, such as `40ms` or `1m 15s`, or an empty string for a step that has
 * not started. The web app and the CLI both show a step's duration with it,
 * so the two never disagree about the same step record.
 *
 * A signal's record also returns an empty string: a signal fires at one
 * moment, so the time between its record's start and end is how long the
 * controller took to note it, not anything the signal did. The kind is a
 * required argument so that no caller can forget it.
 */
export const describeStepDuration = (
  times: Timestamps,
  kind: StepLineKind,
  now: number,
): string => {
  if (kind === "signal") return "";
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
 * not be set up or was lost with its runner. For an agent step it returns
 * "schema failure" for a turn that ended without a value matching the step's
 * output schema, and "session failed" for a turn or session that failed
 * before the turn ended.
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
    case "schema-failure":
      return "schema failure";
    case "session-failed":
      return "session failed";
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
   * The ids of the steps that wait: the running agent steps and workspace
   * steps of a run whose runner is offline, or the pending workspace steps of
   * a run that no runner has taken yet.
   */
  readonly stepIds: ReadonlySet<string>;
  /**
   * "Waiting for runner mac-mini to reconnect (offline since 25 Sep 14:02)",
   * or "Waiting for a runner that can run git.commit".
   */
  readonly text: string;
}

/**
 * Returns which steps of a running run wait for a runner, and the line they
 * show, with times in `timezone`. An action step waits only when its action
 * runs in the workspace, which `actions`, the action catalog, tells. An
 * action step that runs on the controller, or whose action is no longer in
 * the catalog, never waits. There are two waits:
 *
 * - The run is pinned to a runner that is not online. Its running workspace
 *   steps and agent steps wait for that runner without limit, because both
 *   run on the runner the run is pinned to: an agent step's session does.
 *   The line is "Waiting for runner mac-mini to reconnect (offline since
 *   25 Sep 14:02)"; the part in brackets is left out when the runner has
 *   never been seen.
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
  /** Returns the ids of the plan's steps with a record in `status` that `waitsFor` accepts. */
  const listWaitingStepIds = (
    status: StepStatus,
    waitsFor: (step: Run["plan"]["steps"][number]) => boolean,
  ): ReadonlySet<string> =>
    new Set(
      run.steps
        .filter((record) => record.status === status)
        .map((record) => record.stepId)
        .filter((stepId) => {
          const step = run.plan.steps.find((each) => each.id === stepId);
          return step !== undefined && waitsFor(step);
        }),
    );
  const isWorkspaceAction = (step: Run["plan"]["steps"][number]): boolean =>
    step.kind === "action" && workspaceActionIds.has(step.action);

  if (run.runnerId === undefined) {
    const stepIds = listWaitingStepIds("pending", isWorkspaceAction);
    if (stepIds.size === 0) return undefined;
    const planActionIds = new Set(
      run.plan.steps.flatMap((step) =>
        step.kind === "action" && workspaceActionIds.has(step.action) ? [step.action] : [],
      ),
    );
    return {
      stepIds,
      text: `Waiting for a runner that can run ${formatNameList(planActionIds, "and")}`,
    };
  }

  if (runner === undefined || runner.id !== run.runnerId) return undefined;
  if (runner.connectivity === "online") return undefined;
  const stepIds = listWaitingStepIds(
    "running",
    (step) => step.kind === "agent" || isWorkspaceAction(step),
  );
  if (stepIds.size === 0) return undefined;
  const waiting = `Waiting for runner ${runner.name} to reconnect`;
  const since =
    runner.lastSeenAt === null ? undefined : formatStamp(new Date(runner.lastSeenAt), timezone);
  return { stepIds, text: since === undefined ? waiting : `${waiting} (offline since ${since})` };
};

/**
 * Returns the ids of the signal triggers a run waits on, in the plan's order,
 * or an empty list when the run waits on none. A run waits on its signals
 * when all of these hold:
 *
 * - it is `running`;
 * - none of its step records is running or pending;
 * - its plan has signal triggers.
 *
 * A run has no status of its own for this wait: it stays `running` until it
 * ends, because each signal trigger can fire again while the run lives. A
 * signal that just fired has a pending record until the run takes it up, so
 * for that moment the run does not wait. See spec 07 §7.2.
 */
export const listAwaitedSignals = (
  run: Pick<Run, "status" | "plan" | "steps">,
): ReadonlyArray<string> => {
  if (run.status !== "running") return [];
  const isBusy = run.steps.some(
    (record) => record.status === "running" || record.status === "pending",
  );
  if (isBusy) return [];
  return (run.plan.triggers ?? [])
    .filter((trigger) => trigger.kind === "signal")
    .map((trigger) => trigger.id);
};

/**
 * The session an agent step's record drives, and whether the record is the
 * newest of the run's records that drive it. A step that runs again in the
 * same session, such as one a signal sends back to, has several records that
 * drive one session.
 */
export interface StepRecordSession {
  readonly id: string;
  /** Whether no record created after this one drives the same session. */
  readonly isNewestRecord: boolean;
}

/** The session an agent step's record drove, as the line under the record shows it. */
export interface StepSessionReading {
  readonly sessionId: string;
  /**
   * The session's status, or `undefined` while the session has not been
   * read, and on every record but the newest that drives the session.
   */
  readonly status: SessionStatus | undefined;
  /**
   * Why a queued session has not started, such as "Waiting for runner atlas
   * to free a session slot", or `undefined` for a session that is not queued
   * and on every record but the newest that drives the session.
   */
  readonly wait: string | undefined;
}

/**
 * Returns how the lines under an agent step's record show `recordSession`,
 * the session the record drove, looked up by its id in `sessions`, the run's
 * sessions. The line names the session by the tail of its id, not by its
 * title: a step session's title, such as "Fix and ship a pull request ·
 * implement", only repeats the workflow and the step the run's page already
 * shows.
 *
 * - Only the newest record that drives the session shows the session's
 *   status and wait. The status is the session's now, not the record's: an
 *   earlier record that completed would read "busy" while a later record
 *   runs in the same session.
 * - A session missing from `sessions`, such as one that started after they
 *   were last read, has no status.
 * - A queued session on an online `runner` waits for the runner to free one
 *   of its session slots, because the runner already runs as many sessions as
 *   it may. A queued session on a runner that is not online waits for the
 *   runner to reconnect instead; `describeRunnerWait` writes that line, so
 *   this reading has no wait then. Neither has one while the runner is
 *   unknown.
 */
export const describeStepSession = (
  recordSession: StepRecordSession,
  sessions: readonly Session[],
  runner: Runner | undefined,
): StepSessionReading => {
  const session = recordSession.isNewestRecord
    ? sessions.find((each) => each.id === recordSession.id)
    : undefined;
  const isWaitingForSlot =
    session?.status === "queued" &&
    runner?.id === session.runnerId &&
    runner.connectivity === "online";
  return {
    sessionId: recordSession.id,
    status: session?.status,
    wait: isWaitingForSlot ? `Waiting for runner ${runner.name} to free a session slot` : undefined,
  };
};
