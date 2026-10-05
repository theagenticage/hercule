/**
 * The run engine: starts runs of workflows and executes their steps.
 *
 * Starting a run (`start.ts`) writes the run and a step record for each entry
 * step, and returns. Once those rows commit, the engine hands the run's
 * execution to the Run Executor (`executor.ts`), which carries it out apart
 * from the request that started the run. The engine decides what a run does;
 * the controller daemon, which implements the Run Executor, decides where
 * that work runs.
 *
 * The run's execution reads the run and starts a child fiber for each step
 * that has a pending record, so steps on parallel branches run at the same
 * time. A step never has two records running: a record queued behind a
 * running one of the same step starts after it, in iteration order. Each
 * child fiber:
 *
 * 1. Takes one step record that is pending, or running because a restart
 *    cut it off.
 * 2. The start transaction: it reads the run again and evaluates the step's
 *    condition. If the condition holds, or the step has none, it renders the
 *    step's params from the run's inputs and the outputs of the steps that
 *    have finished, decodes them with the action's input schema, and moves
 *    the record to `running` with that input stored on it. If the condition
 *    is false, the record moves to `skipped` and the run is routed as if the
 *    step had completed (see step 4). If the condition or the params cannot
 *    be decided, the record and the run fail.
 * 3. It calls the action. A built-in action is called as the run, in the
 *    same transaction that ends its record; `wait` is the exception, because
 *    it holds no transaction while it waits. A plugin's action is called
 *    outside any transaction, and its record ends afterwards.
 * 4. The end transaction: it ends the step record, reads the run again, and
 *    routes it (`routing.ts`): it follows the edges whose conditions hold,
 *    adds the records of the steps that are ready, and completes or fails
 *    the run when routing says so. A `terminal` step that completes ends
 *    the run with its output, without following its edges.
 *
 * A workspace step runs on a runner: an action step whose action runs in the
 * run's workspace (such as `git.commit`), or an agent step, whose turn runs
 * in a session (`agent-steps.ts`). It is different at steps 2 and 3:
 *
 * - The start transaction of the run's first workspace step pins the run to
 *   a runner, and opens the run's workspace there when the plan has one.
 *   Every later workspace step of the run runs on that runner, in that
 *   workspace. When no runner can take the run, the record stays pending
 *   and the run waits for a runner.
 * - An agent step's start transaction also opens the step's session, and
 *   the record stores the session's id instead of an input.
 * - After the start transaction commits, the step is handed to its runner
 *   through Workspace Steps (`workspace-steps.ts`), and the child fiber ends.
 *   No fiber waits for the step: its result arrives later from the runner
 *   (`completeStep`), and the end transaction runs then.
 *
 * A signal trigger has no action. From the run's start until it ends, the
 * run holds a subscription for each of its signal triggers. An event that
 * matches one, and correlates with the run, writes a pending record for the
 * trigger, holding the signal's output (`signals.ts`), and wakes the run.
 * Its child fiber completes that record and routes the run, in one
 * transaction. A run with a signal trigger does not complete when its steps
 * are done: it sleeps until the next signal, and ends only through a
 * terminal step, a failure or a cancel.
 *
 * Each time a child fiber ends, the run's execution reads the run again and
 * starts the child fibers that are now ready, until the run has ended. Then
 * it interrupts the child fibers still executing, as a cancel does. When the
 * run has not ended but nothing is left that the execution can do, because
 * every unfinished record is a workspace step running on a runner or waiting
 * for one, the execution returns and the run is asleep. A step result, or a
 * runner that arrives, wakes it through the Run Executor.
 *
 * Every routing decision is made in a start or an end transaction, against
 * rows read inside it, so the decision and its writes commit together. A
 * built-in action's effect and the end of its step record commit together
 * too, so a crash never leaves the effect committed with the step still
 * unfinished. A failed step, or a template that cannot be rendered, fails the
 * run and cancels every step record that is still pending or running.
 *
 * Nothing about a run is held only in memory. When the controller starts, it
 * resumes every run that is pending or running from its rows. A built-in
 * action's step record found `running` then is executed again: its action
 * calls the controller's own services, in the transaction that would have
 * ended the record, so a record still `running` means that transaction never
 * committed and the action took no effect. A `wait` step waits only for the
 * time it had left. A workspace step's record found `running` is left
 * running: the runner still runs the step, or runs it again from its stored
 * input when it connects, and runs it once; for an agent step, the runner is
 * asked again how the step's turn ended. A plugin's action reaches outside
 * the controller, so its step record found `running` may or may not have
 * taken effect; runs never retry such an action, and the step fails with the
 * code `interrupted`. When several were running, the first fails and the run
 * cancels the others.
 *
 * Cancelling a run ends it, its unfinished step records, and every unfinished
 * run its steps started, directly or further down, in one transaction. Then
 * the Run Executor stops their executions, the workspace steps that were
 * running are settled with their runners, which stop them, and the runs'
 * sessions are stopped. A plugin's action in flight sees its signal abort.
 * An action that returns after the cancel cannot end its step record any
 * more, so the run stays cancelled and no later step starts.
 *
 * If executing a run fails for a reason of the controller's own, such as a
 * database error or a bug, the run fails with `controller-error` rather than
 * staying `running` until the next restart: at the step whose child fiber
 * failed, or with no failed step when the run's execution itself failed.
 *
 * A method that takes only an id does not decode it again: the transport has
 * already decoded a request's id against the contract, and a caller inside
 * the controller passes an id it read from a stored row.
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { isSqlError, type SqlError } from "effect/unstable/sql/SqlError";
import {
  createDecodeValidationError,
  createInvalidStateError,
  createNotFoundError,
  Id,
  RunCancelInput,
  type Forbidden,
  type InvalidState,
  type NotFound,
  type Run,
  type RunStatus,
  type StepError,
  type Unauthenticated,
  type Validation,
  type WorkflowDefinition,
  type WorkspacePolicy,
} from "@hercule/contract";
import type { WorkspaceStepKey, WorkspaceStepResult } from "@hercule/protocol";
import { buildRunActor, CurrentActor, currentStampOrSystem, requireGrant } from "../actor";
import { AfterCommit, afterCommit, nowIso, UUID_PATTERN, withTransaction } from "../db";
import { isBuiltInControllerActionId, PluginHost, runsInWorkspace } from "../plugins";
import { PlatformEvents } from "../events";
import { Notifier } from "../notifications";
import { runnerRepository } from "../runners";
import { isGitActionId } from "../workflows";
import { runHeldSubscriptions } from "../subscriptions";
import { buildRunBranch, WorkspaceService, type Retention } from "../workspaces";
import {
  decideAgentStepFailureReason,
  ENDED,
  findAgentStep,
  makeAgentSteps,
  WAITS_FOR_RUNNER,
  type WorkspaceStepPlacement,
} from "./agent-steps";
import { RunExecutor } from "./executor";
import {
  runRepository,
  type ExecutionFailureReason,
  type RunOutcome,
  type StepRecordId,
} from "./repository";
import { decideRouting, isStepConditionMet, listSignalTriggerIds } from "./routing";
import {
  describeMissingCapableRunner,
  listCapableRunners,
  listRequiredCapabilities,
} from "./runner-capabilities";
import {
  buildRunEndedEvent,
  buildRunFailedNotification,
  decideRunFailedUnlessRaised,
} from "./run-events";
import { StepSessionFailures } from "./session-observer";
import { makeSignalMatching } from "./signals";
import { makeRunStart } from "./start";
import {
  buildActionUnavailableError,
  findActionStep,
  makeStepExecution,
  type EngineStepError,
  type StepRecordKey,
} from "./step";
import { isUnfinished, listNextStepRecords, type UnfinishedStepRecord } from "./step-records";
import {
  WorkspaceSteps,
  type ActionStepToStart,
  type OpenedStepSession,
  type WorkspaceStepToStart,
  type WorkspaceStepToSettle,
} from "./workspace-steps";

/**
 * The step error for a run that could not be carried out at this step for a
 * reason of the controller's own, such as a bug, whether or not the step's
 * action had started.
 */
const UNEXPECTED_RUN_FAILURE: EngineStepError = {
  code: "unexpected",
  message:
    "The controller could not carry out the run at this step. The controller's log has the details.",
};

/** The step error for a plugin action's step record that a restart cut off while the action ran. */
const INTERRUPTED: EngineStepError = {
  code: "interrupted",
  message:
    "The controller stopped while this step's action was running, so it may or may not have taken effect. Runs never retry an action; start a new run if it is needed.",
};

/**
 * What the start transaction did with a pending step record:
 *
 * - `started`: the record is `running` with `input` stored on it. For a
 *   workspace step, `workspaceStep` is what to hand to its runner once the
 *   transaction has committed.
 * - `sessionOpened`: the record is an agent step's, `running` with its
 *   session, and `send` starts the session or delivers its prompt once the
 *   transaction has committed.
 * - `ended`: the record ended in the transaction (skipped or failed), or had
 *   already ended.
 * - `waitsForRunner`: the record is a workspace step of a run that no runner
 *   can take now, and it stays pending.
 */
type StartedRecord =
  | {
      readonly _tag: "started";
      readonly run: Run;
      readonly startedAt: string;
      readonly input: Schema.Json;
      readonly workspaceStep?: ActionStepToStart;
    }
  | { readonly _tag: "sessionOpened"; readonly send: OpenedStepSession["send"] }
  | typeof ENDED
  | typeof WAITS_FOR_RUNNER;

/**
 * What executing one step record did, as its child fiber reports it to the
 * run's execution: it ran its course, or it waits for a runner.
 */
type RecordProgress = "executed" | "waitsForRunner";

/**
 * Checks whether a step of a plan runs on the run's runner: an agent step,
 * or an action step whose action runs in the run's workspace.
 */
const isWorkspaceStep = (plan: WorkflowDefinition, stepId: string): boolean => {
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  return step?.kind === "agent" || (step?.kind === "action" && runsInWorkspace(step.action));
};

/** Returns the `resourceId` a step's input names, if it names one. */
const readResourceId = (input: Schema.Json): string | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const resourceId = (input as { readonly resourceId?: unknown }).resourceId;
  return typeof resourceId === "string" ? resourceId : undefined;
};

/**
 * Returns the branch a run's checkout is switched to before each workspace
 * step: the branch a policy for a repo's main workspace names, if it names
 * one. An ephemeral workspace is already on the run's own branch.
 */
const readCheckoutBranch = (policy: WorkspacePolicy | undefined): string | undefined =>
  policy?.kind === "primary" ? policy.branch : undefined;

/**
 * Builds the action step to hand to a runner from its step record: the
 * `resourceId` its input names, and the branch its run's workspace policy
 * switches the checkout to.
 */
const buildActionStepToStart = (
  step: Omit<ActionStepToStart, "kind" | "resourceId" | "checkoutBranch">,
  policy: WorkspacePolicy | undefined,
): ActionStepToStart => {
  const resourceId = readResourceId(step.input);
  const checkoutBranch = readCheckoutBranch(policy);
  return {
    kind: "action",
    ...step,
    ...(resourceId === undefined ? {} : { resourceId }),
    ...(checkoutBranch === undefined ? {} : { checkoutBranch }),
  };
};

/** Formats a step's key as one string, to compare keys in a set. */
const formatStepKey = (key: WorkspaceStepKey): string =>
  `${key.runId}/${key.stepId}/${key.iteration}`;

/** Returns the ids of the repos a run's workspace holds a checkout of. */
const listPolicyResourceIds = (policy: WorkspacePolicy): ReadonlyArray<string> =>
  policy.kind === "primary"
    ? [policy.resourceId]
    : policy.checkouts.map((checkout) => checkout.resourceId);

/**
 * Checks that a workspace step can run in the run's workspace, before a
 * runner is chosen or a workspace opened. Returns the error the step fails
 * with, or `undefined` when it can run: a `resourceId` in a git action's
 * input must name one of the workspace's checkouts. Validation at save and at
 * `run.start` refused every other mistake, but a `resourceId` can come from a
 * template, so only the rendered input shows this one.
 */
const findWorkspaceStepError = (
  policy: WorkspacePolicy,
  action: string,
  input: Schema.Json,
): EngineStepError | undefined => {
  if (!isGitActionId(action)) return undefined;
  const resourceIds = listPolicyResourceIds(policy);
  const resourceId = readResourceId(input);
  if (resourceId !== undefined && !resourceIds.includes(resourceId)) {
    return {
      code: "validation",
      message: `The run's workspace has no checkout of the resource ${resourceId}. Set resourceId to one of the workspace's repos: ${resourceIds.join(", ")}.`,
    };
  }
  return undefined;
};

/**
 * Returns the workspace steps to settle for the records of a run that were
 * running when the run ended: those of its workspace steps, on the runner the run is
 * pinned to. A run that was never pinned has no workspace step running.
 */
const listWorkspaceStepsToSettle = (
  run: Run,
  wasRunning: ReadonlyArray<StepRecordId>,
): ReadonlyArray<WorkspaceStepToSettle> => {
  const { runnerId } = run;
  if (runnerId === undefined) return [];
  return wasRunning
    .filter((record) => isWorkspaceStep(run.plan, record.stepId))
    .map(({ stepId, iteration }) => ({ runnerId, runId: run.id, stepId, iteration }));
};

const decodeCancel = Schema.decodeUnknownEffect(RunCancelInput);

/**
 * Decides how long a run's workspace is kept after the run ends:
 *
 * - a completed run needs nothing more from it (`none`);
 * - a failed run keeps it for inspection, so the user can see what the
 *   failing step left behind (`inspection`);
 * - a cancelled run keeps it for inspection only when the user asked for
 *   that with `keepWorkspace`, and needs nothing more from it otherwise.
 */
const decideRetention = (outcome: RunOutcome): Retention => {
  switch (outcome.status) {
    case "completed":
      return "none";
    case "failed":
      return "inspection";
    case "cancelled":
      return outcome.keepWorkspace ? "inspection" : "none";
  }
};

/** Describes how a run ended, for the refusal to cancel it. */
const describeEnding = (status: RunStatus): string =>
  status === "cancelled" ? "has already been cancelled" : `has already ${status}`;

/**
 * Builds the run engine: `start`, `cancel` and `resumeUnfinished`, which the
 * run service serves (`service.ts`).
 */
export const makeRunEngine = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runs = yield* runRepository;
  const executor = yield* RunExecutor;
  const workspaceSteps = yield* WorkspaceSteps;
  const platformEvents = yield* PlatformEvents;
  const notifier = yield* Notifier;
  const workspaces = yield* WorkspaceService;
  const runners = yield* runnerRepository;
  const host = yield* PluginHost;
  const runHeld = yield* runHeldSubscriptions;
  const stepSessionFailures = yield* StepSessionFailures;
  // The listener that publishes a committed change on the live topics. A
  // run's execution is carried out apart from the request that started it,
  // so the listener is provided to the execution here.
  const afterCommitListener = yield* AfterCommit;
  // A new run is handed to the Run Executor through a function the engine
  // defines below, which itself calls `start` for the `run.start` action, so
  // the reference is passed as a function. A run that cannot start ends
  // through `writeRunEnding`, defined below for the same reason.
  const { start, rerun, startTriggeredRun } = yield* makeRunStart(
    (runId) => executeInBackground(runId),
    (runId, outcome, at) => writeRunEnding(runId, outcome, at),
  );
  const { recordSignalMatch } = yield* makeSignalMatching((runId) => executeInBackground(runId));

  /**
   * Ends a run: cancels every step record of it that is still pending or
   * running, and moves the run to `outcome`. Every way a run ends goes
   * through here, inside the transaction that decided it, so a reader never
   * sees an ended run with a step record still pending or running.
   *
   * A run that had a workspace releases its lease on it here, with the
   * retention its ending calls for (`decideRetention`). The subscriptions
   * the run holds for its signal triggers end here too, so no signal
   * arrives for a run that has ended. The sessions of its agent steps that
   * have not exited are stopped once the transaction commits: no turn of
   * theirs is owed to the run any more, and a session that kept running
   * would keep its slot on the runner and its lease on the workspace.
   *
   * The run's platform event (`run.completed`, `run.failed` or
   * `run.cancelled`) is emitted here too, in the same transaction, so every
   * way a run ends emits exactly one event, and only if the ending commits.
   * A failed run also raises its `core.run-failed` notification here, for
   * the same reason.
   * The event's actor is whoever's request ended the run: the user or a
   * session cancelling it, or a run whose step cancelled it. A run that ends
   * on its own ends with no request behind it, so its event is stamped
   * `system`.
   *
   * Once the transaction has committed, the workspace steps whose records
   * were running are settled with the run's runner (see
   * `settleWorkspaceSteps`).
   */
  const writeRunEnding = (
    runId: string,
    outcome: RunOutcome,
    at: string,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      // Runs are never deleted, and every caller has found this one.
      const run = Option.getOrThrow(yield* runs.read(runId));
      const wasRunning = yield* runs.cancelUnfinishedSteps(runId, at);
      yield* runs.finish(runId, outcome, at);
      // `finish` leaves a run that has already ended alone, and so does this:
      // releasing again would replace the retention its real ending chose,
      // and a second event would report an ending that did not happen.
      if (isUnfinished(run.status)) {
        if (run.workspaceId !== undefined) {
          yield* workspaces.release({ kind: "run", id: runId }, decideRetention(outcome), at);
        }
        yield* runHeld.end(runId, at);
        yield* workspaceSteps.stopSessions(run);
        const eventId = yield* platformEvents.emit(
          buildRunEndedEvent(run, outcome, at, yield* currentStampOrSystem),
        );
        if (outcome.status === "failed") {
          yield* notifier.createCoreNotification(
            buildRunFailedNotification(run, outcome, eventId),
            { unlessRaised: decideRunFailedUnlessRaised(run, outcome) },
          );
        }
      }
      yield* settleWorkspaceSteps(run, wasRunning);
    });

  /**
   * Settles the workspace steps among `ended` with the runner the run is
   * pinned to, once the caller's transaction has committed: the controller
   * no longer owes them. The runner stops such a step if it is still
   * running, deletes its result file, and ignores a late start of it.
   * Records of steps that run on the controller are left out.
   */
  const settleWorkspaceSteps = (
    run: Run,
    ended: ReadonlyArray<StepRecordId>,
  ): Effect.Effect<void> => {
    const toSettle = listWorkspaceStepsToSettle(run, ended);
    return toSettle.length === 0 ? Effect.void : afterCommit(() => workspaceSteps.settle(toSettle));
  };

  /**
   * Fails a run at one of its steps, inside the caller's transaction: the
   * step record fails with `error`, and the run fails with `failureReason`
   * (see `writeRunEnding`). A record that has already ended keeps its ending.
   */
  const writeStepFailure = (
    runId: string,
    attempt: StepRecordKey,
    error: StepError,
    failureReason: ExecutionFailureReason,
    at: string,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      yield* Effect.catchTag(
        runs.finishStep(
          runId,
          attempt,
          { status: "failed", error },
          { startedAt: attempt.startedAt ?? at, finishedAt: at },
        ),
        "StepRecordEnded",
        () => Effect.void,
      );
      yield* writeRunEnding(
        runId,
        { status: "failed", failureReason, failedStepId: attempt.stepId },
        at,
      );
    });

  /** Fails a run at one of its steps (see `writeStepFailure`), in a transaction of its own. */
  const failRun = (
    runId: string,
    attempt: StepRecordKey,
    error: StepError,
    failureReason: ExecutionFailureReason,
  ): Effect.Effect<void, SqlError> =>
    withTransaction(
      sql,
      Effect.flatMap(nowIso, (at) => writeStepFailure(runId, attempt, error, failureReason, at)),
    );

  /**
   * Routes a run after the latest record of `stepId` finished, inside the
   * caller's transaction, which has already written that record's ending.
   * Reads the run again, so the decision sees every row the transaction can,
   * and writes the decision: the edges followed, the new pending records,
   * and the run's ending when routing ends it (see `decideRouting`).
   */
  const routeAfterStep = (
    runId: string,
    stepId: string,
    at: string,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      // Runs are never deleted, and the caller has just written a record of
      // this one.
      const run = Option.getOrThrow(yield* runs.read(runId));
      const decision = yield* decideRouting(run, stepId);
      yield* runs.recordTraversals(runId, decision.traversedEdgeIndexes);
      yield* runs.insertSteps(runId, decision.readyStepIds, at);
      const { ending } = decision;
      if (ending._tag === "completed") {
        yield* writeRunEnding(runId, { status: "completed", output: ending.output }, at);
      } else if (ending._tag === "failed") {
        yield* writeRunEnding(
          runId,
          {
            status: "failed",
            failureReason: ending.failureReason,
            failedStepId: stepId,
            failedEdge: ending.failedEdge,
          },
          at,
        );
      }
    });

  /**
   * Chooses the runner a run is pinned to. Only a runner that offers every
   * capability the plan needs is considered (see `runner-capabilities.ts`),
   * that is signed in to the provider of every Agent its agent steps name
   * (see `filterAgentHosts`), and of those only a placeable one: online,
   * active and not reserved. For a repo's main workspace, a runner that
   * already holds it ready is preferred, because the run can start there
   * without a fresh clone. Among equals the choice is the lowest id, so it
   * does not change from one try to the next. Returns:
   *
   * - `chosen`, with the runner;
   * - `waits` when a capable runner exists but none is placeable now;
   * - `noCapableRunner`, with the message for the user, when no runner that
   *   is neither retired nor reserved offers every capability the plan
   *   needs, or none of those is signed in to the provider of every Agent
   *   the plan names. `run.start` refuses a plan no runner offers the
   *   capabilities for, so in that case the capable runners were retired or
   *   reserved after the run started.
   */
  const chooseRunner = (
    plan: WorkflowDefinition,
  ): Effect.Effect<
    | { readonly _tag: "chosen"; readonly runnerId: string }
    | { readonly _tag: "waits" }
    | { readonly _tag: "noCapableRunner"; readonly message: string },
    SqlError
  > =>
    Effect.gen(function* () {
      const candidates = yield* runners.listPlacementCandidates();
      const required = listRequiredCapabilities(plan);
      const missing = describeMissingCapableRunner(required, candidates);
      if (missing !== undefined) return { _tag: "noCapableRunner", message: missing } as const;
      const hosts = yield* filterAgentHosts(plan, listCapableRunners(required, candidates));
      if (hosts._tag === "noHost") {
        return { _tag: "noCapableRunner", message: hosts.message } as const;
      }
      const placeable = new Set(
        hosts.candidates
          .filter((candidate) => candidate.placeable)
          .map((candidate) => candidate.id),
      );
      const policy = plan.workspace;
      const holding =
        policy?.kind === "primary"
          ? [...(yield* workspaces.listRunnersWithReadyPrimary(policy.resourceId))].filter(
              (runnerId) => placeable.has(runnerId),
            )
          : [];
      const runnerId = [...(holding.length > 0 ? holding : placeable)].sort()[0];
      return runnerId === undefined ? ({ _tag: "waits" } as const) : { _tag: "chosen", runnerId };
    });

  /**
   * Makes sure a run has a workspace for one of its workspace steps, inside
   * the step's start transaction. A run that is already pinned keeps its
   * runner and workspace. Otherwise this chooses a runner, opens the run's
   * workspace there when its plan has a workspace policy, and pins the run
   * to both; a run whose plan has none is pinned to the runner alone.
   * Returns the runner and the workspace, or the step's other fate:
   *
   * - `ended`: no runner that is neither retired nor reserved can run the
   *   plan, or the workspace cannot be opened, and the step and the run have
   *   failed;
   * - `waitsForRunner`: no runner can take the run now.
   */
  const placeWorkspaceStep = (
    run: Run,
    record: StepRecordKey,
    at: string,
  ): Effect.Effect<WorkspaceStepPlacement, SqlError> =>
    Effect.gen(function* () {
      // `pin` writes the runner and the workspace together, so a pinned run
      // with no workspace is one whose plan has none.
      if (run.runnerId !== undefined) {
        return {
          _tag: "placed",
          runnerId: run.runnerId,
          workspaceId: run.workspaceId ?? null,
        } as const;
      }
      const chosen = yield* chooseRunner(run.plan);
      if (chosen._tag === "waits") return WAITS_FOR_RUNNER;
      if (chosen._tag === "noCapableRunner") {
        yield* writeStepFailure(
          run.id,
          record,
          { code: "workspace_failed", message: chosen.message },
          "workspace-failed",
          at,
        );
        return ENDED;
      }
      const { runnerId } = chosen;
      const policy = run.plan.workspace;
      if (policy === undefined) {
        yield* runs.pin(run.id, { runnerId, workspaceId: null });
        return { _tag: "placed", runnerId, workspaceId: null } as const;
      }
      const actor = buildRunActor(run, record.stepId);
      const opened = yield* Effect.result(
        Effect.provideService(
          workspaces.openFor({
            holder: { kind: "run", id: run.id },
            wish: policy,
            heldWorkspaceId: null,
            runnerId,
            // A run belongs to no project, so its repos are not checked
            // against one.
            projectId: undefined,
            branch: buildRunBranch(run.id),
            at,
          }),
          CurrentActor,
          actor,
        ),
      );
      if (Result.isFailure(opened)) {
        if (isSqlError(opened.failure)) return yield* Effect.fail(opened.failure);
        yield* writeStepFailure(
          run.id,
          record,
          {
            code: "workspace_failed",
            message: `The run's workspace could not be opened: ${opened.failure.message}`,
          },
          "workspace-failed",
          at,
        );
        return ENDED;
      }
      const workspaceId = opened.success.workspaceId;
      // A primary or an ephemeral wish always opens or joins a workspace.
      if (workspaceId === null) {
        return yield* Effect.die(`opening the workspace of run ${run.id} gave no workspace`);
      }
      yield* runs.pin(run.id, { runnerId, workspaceId });
      return { _tag: "placed", runnerId, workspaceId } as const;
    });

  /**
   * Starts a pending step record, in a transaction of its own. Reads the run
   * again and evaluates the step's condition:
   *
   * - true, or no condition: the step's input is prepared (see
   *   `prepareInput`), and the record moves to `running` with the input
   *   stored on it. A workspace step is first given its workspace (see
   *   `placeWorkspaceStep`). This returns `started`, with the run as read.
   *   An agent step opens its session instead (see `startAgentStep`), and
   *   this returns `sessionOpened`.
   * - false: the record moves to `skipped`, and the run is routed as if the
   *   step had completed.
   * - the condition cannot be decided: the record fails with
   *   `expression_error`, and the run fails at the step.
   *
   * An input that cannot be prepared fails the record and the run too. This
   * returns `ended` in those cases, and when the record is no longer pending,
   * for example because the run was cancelled.
   */
  const startStepRecord = (
    runId: string,
    record: StepRecordKey,
  ): Effect.Effect<StartedRecord, SqlError> =>
    Effect.catchTag(
      withTransaction(
        sql,
        Effect.gen(function* () {
          const at = yield* nowIso;
          const run = Option.getOrThrow(yield* runs.read(runId));
          // The run's execution never starts a record of a step that has one
          // running, so this only catches a bug in `executeRun`. It is
          // checked here, against rows read in the transaction, because a
          // step with two running records would corrupt the run.
          if (
            run.steps.some((other) => other.stepId === record.stepId && other.status === "running")
          ) {
            return yield* Effect.die(
              `step ${record.stepId} of run ${runId} would have two running records`,
            );
          }
          const met = yield* Effect.result(isStepConditionMet(run, record.stepId));
          if (Result.isFailure(met)) {
            yield* writeStepFailure(
              runId,
              record,
              {
                code: "expression_error",
                message: `The condition of this step failed: ${met.failure.message}`,
              },
              "expression-error",
              at,
            );
            return ENDED;
          }
          if (!met.success) {
            yield* runs.skipStep(runId, record, at);
            yield* routeAfterStep(runId, record.stepId, at);
            return ENDED;
          }
          const agentStep = findAgentStep(run.plan, record.stepId);
          if (agentStep !== undefined) return yield* startAgentStep(run, record, agentStep, at);
          const step = findActionStep(run, record.stepId);
          const prepared = yield* prepareInput(run, step);
          if (Result.isFailure(prepared)) {
            const { error, failureReason } = prepared.failure;
            yield* writeStepFailure(runId, record, error, failureReason, at);
            return ENDED;
          }
          const input = prepared.success;
          if (!runsInWorkspace(step.action)) {
            yield* runs.startStep(runId, record, { input }, at);
            return { _tag: "started", run, startedAt: at, input } as const;
          }
          const policy = run.plan.workspace;
          // Validation at `run.start` refuses a plan with a workspace action and
          // no workspace, and a run's plan never changes after that.
          if (policy === undefined) {
            return yield* Effect.die(`run ${runId} has a workspace action and no workspace policy`);
          }
          const refused = findWorkspaceStepError(policy, step.action, input);
          if (refused !== undefined) {
            yield* writeStepFailure(runId, record, refused, "step-failed", at);
            return ENDED;
          }
          const placed = yield* placeWorkspaceStep(run, record, at);
          if (placed._tag !== "placed") return placed;
          // A run with a workspace policy is pinned together with its workspace.
          if (placed.workspaceId === null) {
            return yield* Effect.die(`run ${runId} is pinned with no workspace`);
          }
          yield* runs.startStep(runId, record, { input }, at);
          return {
            _tag: "started",
            run,
            startedAt: at,
            input,
            workspaceStep: buildActionStepToStart(
              {
                runId,
                stepId: record.stepId,
                iteration: record.iteration,
                runnerId: placed.runnerId,
                workspaceId: placed.workspaceId,
                action: step.action,
                input,
              },
              policy,
            ),
          } as const;
        }),
      ),
      "StepRecordEnded",
      () => Effect.succeed(ENDED),
    );

  const { prepareInput, executeStep } = yield* makeStepExecution({
    start,
    failRun,
    routeAfterStep,
  });

  const { startAgentStep, filterAgentHosts } = yield* makeAgentSteps({
    writeStepFailure,
    placeOnRunner: placeWorkspaceStep,
  });

  /**
   * Completes a pending record of a signal trigger, which an event wrote
   * (see `signals.ts`), and routes the run from the trigger as from a step
   * that completed, in one transaction. The record already holds the
   * signal's output, so nothing else is executed. A record that is no longer
   * pending, because the run ended first, is left alone.
   */
  const deliverSignal = (runId: string, record: StepRecordKey): Effect.Effect<void, SqlError> =>
    Effect.catchTag(
      withTransaction(
        sql,
        Effect.gen(function* () {
          const at = yield* nowIso;
          yield* runs.completeSignalStep(runId, record, at);
          yield* routeAfterStep(runId, record.stepId, at);
        }),
      ),
      "StepRecordEnded",
      () => Effect.void,
    );

  /**
   * Executes one step record of a run, on a child fiber of the run's
   * execution (see `executeRun`). A signal trigger's record is delivered
   * (see `deliverSignal`). A pending record is started first (see
   * `startStepRecord`). A running record is one a restart cut off, and only
   * a built-in action's record gets here that way: it is executed again.
   *
   * A workspace step is handed to its runner once its start transaction has
   * committed: an action step through Workspace Steps, and an agent step by
   * starting its session or delivering its prompt. This returns without
   * waiting for the step to end. Returns
   * `waitsForRunner` when the step could not start because no runner can
   * take the run.
   *
   * If executing the record fails for a reason of the controller's own, such
   * as a database error or a bug, the run fails with `controller-error` at
   * this record, which fails with the code `unexpected`. This effect fails
   * only when that ending cannot be written either.
   */
  const executeRecord = (
    run: Run,
    record: UnfinishedStepRecord,
  ): Effect.Effect<RecordProgress, SqlError> =>
    Effect.catchCause(
      Effect.gen(function* () {
        if (listSignalTriggerIds(run.plan).includes(record.stepId)) {
          yield* deliverSignal(run.id, record);
          return "executed" as const;
        }
        if (record.status === "running") {
          // `startStep` stores the input of every record it starts, so a
          // running record without one is a bug. The run fails with
          // `controller-error` below rather than calling the action with an
          // input it was never checked against.
          if (record.input === undefined) {
            return yield* Effect.die(
              `step ${record.stepId} of run ${run.id} is running with no input stored`,
            );
          }
          yield* executeStep(run, record, record.input);
          return "executed" as const;
        }
        const started = yield* startStepRecord(run.id, record);
        if (started._tag === "waitsForRunner") return "waitsForRunner" as const;
        if (started._tag === "sessionOpened") {
          yield* started.send;
        } else if (started._tag === "started") {
          if (started.workspaceStep !== undefined) {
            yield* workspaceSteps.start(started.workspaceStep);
          } else {
            yield* executeStep(
              started.run,
              { ...record, startedAt: started.startedAt },
              started.input,
            );
          }
        }
        return "executed" as const;
      }),
      (cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.as(
              Effect.andThen(
                Effect.logError(
                  `Executing step ${record.stepId} of run ${run.id} failed, so the run fails`,
                  cause,
                ),
                failRun(run.id, record, UNEXPECTED_RUN_FAILURE, "controller-error"),
              ),
              "executed" as const,
            ),
    );

  /**
   * Executes a run from its rows until it has ended. This is the run's
   * execution, which the Run Executor carries out.
   *
   * Each step's next record (see `listNextStepRecords`) executes on a child
   * fiber of its own (see `executeRecord`), so steps on parallel branches run
   * at the same time. A step has at most one child fiber, so a record queued
   * behind a running one of the same step waits until that one has ended.
   *
   * Each time a child fiber ends, the run's execution reads the run again, because
   * that child's transactions may have added records or ended the run. It
   * never decides from an older read: which records are ready is always read
   * from the rows after the last child's writes committed.
   *
   * A workspace step's running record gets no child fiber: its runner runs
   * it, and its result wakes the run. A wake (see `RunExecutor.execute`)
   * that arrives while children are still executing makes the execution
   * read the run again at once, so a step routed to by a workspace step's
   * result starts without waiting for a long `wait` on another branch. A
   * workspace step that finds no runner waits until another child has made
   * progress or a wake arrives. If either happened while the step was still
   * looking, the step is tried again at once, because it may have read the
   * runners before the change. When no child fiber is left and the run
   * still has such records, the execution returns and the run is asleep.
   *
   * When the run has ended, the execution returns, and closing its scope
   * interrupts the child fibers still executing: a `wait` stops, and a
   * plugin's action sees its signal abort. Stopping the execution, when the
   * run is cancelled or the controller stops, interrupts them the same way.
   */
  const executeRun = (runId: string, wakes: Queue.Dequeue<void>): Effect.Effect<void, SqlError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const endedChildren = yield* Queue.unbounded<{
          readonly record: UnfinishedStepRecord;
          readonly exit: Exit.Exit<RecordProgress, SqlError>;
        }>();
        // How many times a runner may have become free during this
        // execution: once per wake, and once per child that made progress.
        let runnerChanges = 0;
        // The steps whose record a child fiber is executing, each with the
        // value of `runnerChanges` when its child started. Only this loop
        // changes the map, so it is never stale.
        const busySteps = new Map<string, number>();
        // The steps whose next record is a workspace step that found no
        // runner. They are not tried again until a runner may have become
        // free, or the loop would try them over and over.
        const stepsWaitingForRunner = new Set<string>();
        const retryStepsWaitingForRunner = (): void => {
          stepsWaitingForRunner.clear();
          runnerChanges += 1;
        };
        for (;;) {
          const found = yield* runs.read(runId);
          if (Option.isNone(found)) return;
          const run = found.value;
          if (!isUnfinished(run.status)) return;
          if (run.status === "pending") {
            yield* withTransaction(
              sql,
              Effect.flatMap(nowIso, (at) => runs.start(runId, at)),
            );
          }
          const next = listNextStepRecords(run.steps).filter(
            (record) => !busySteps.has(record.stepId) && !stepsWaitingForRunner.has(record.stepId),
          );
          // A workspace step's running record is its runner's to run; the
          // result arrives on its own and wakes the run.
          const onRunner = next.filter(
            (record) => record.status === "running" && isWorkspaceStep(run.plan, record.stepId),
          );
          const ready = next.filter((record) => !onRunner.includes(record));
          // A running record with no child fiber executing it was cut off by
          // a restart. A plugin's action may or may not have taken effect, so
          // the first such record fails the run, which cancels the others.
          const cutOff = ready.find((record) => {
            const step = run.plan.steps.find((candidate) => candidate.id === record.stepId);
            return (
              record.status === "running" &&
              !(step?.kind === "action" && isBuiltInControllerActionId(step.action))
            );
          });
          if (cutOff !== undefined) {
            yield* failRun(runId, cutOff, INTERRUPTED, "step-failed");
            continue;
          }
          for (const record of ready) {
            busySteps.set(record.stepId, runnerChanges);
            yield* Effect.forkScoped(
              Effect.onExit(executeRecord(run, record), (exit) =>
                Queue.offer(endedChildren, { record, exit }),
              ),
            );
          }
          if (busySteps.size === 0 && (onRunner.length > 0 || stepsWaitingForRunner.size > 0)) {
            // Nothing is left that this execution can do: the run sleeps
            // until a step result or a runner wakes it.
            return;
          }
          if (busySteps.size === 0 && listSignalTriggerIds(run.plan).length > 0) {
            // A run with a signal trigger keeps listening once its steps are
            // done (see `decideRouting`): it sleeps until a signal wakes it.
            return;
          }
          if (busySteps.size === 0) {
            // A run without a signal trigger always has a pending or running
            // record until it ends: starting a run creates its entry records,
            // and routing ends the run in the same transaction that ends its
            // last record. Runs left without one by an earlier engine were
            // completed by migration 30. So a run here is a bug in the
            // engine, and it fails rather than completing with nothing to
            // show.
            yield* Effect.logError(
              `Run ${runId} is still running but has no step record to execute. This is a bug in the run engine, so the run fails with controller-error.`,
            );
            return yield* failRunUnexpectedly(runId);
          }
          // Waits for a child to end or for a wake, without taking either
          // message yet: a message taken by the side that lost the race
          // would be lost.
          yield* Effect.raceFirst(Queue.peek(endedChildren), Queue.peek(wakes));
          if (Queue.sizeUnsafe(wakes) > 0) {
            // A step result or a runner woke the run. The next read of the
            // run starts the records that are now ready, and a runner may
            // have become free for the steps that found none.
            yield* Queue.clear(wakes);
            retryStepsWaitingForRunner();
          }
          const polled = yield* Queue.poll(endedChildren);
          if (Option.isNone(polled)) continue;
          const ended = polled.value;
          const runnerChangesAtStart = busySteps.get(ended.record.stepId);
          busySteps.delete(ended.record.stepId);
          if (Exit.isSuccess(ended.exit)) {
            if (ended.exit.value === "waitsForRunner") {
              // When the count moved while the child was looking, a runner
              // may have become free after the child read the runners. The
              // wake or the progress that said so has already been handled,
              // so nothing would ever try the step again. The step is left
              // out of the waiting steps instead, and tried again at once.
              if (runnerChangesAtStart === runnerChanges) {
                stepsWaitingForRunner.add(ended.record.stepId);
              }
            } else {
              // Progress may have freed a runner, so the steps that found
              // none are tried again.
              retryStepsWaitingForRunner();
            }
            continue;
          }
          // Children are interrupted only after the execution has left this
          // loop, by returning or by being interrupted itself. So a child
          // that ended interrupted while the loop still runs interrupted
          // itself, for example a plugin's action that ended in its own
          // interrupt. Nothing else would end that child's record, and the
          // run would stay running, so the run fails at it.
          if (!Cause.hasInterrupts(ended.exit.cause)) {
            return yield* Effect.failCause(ended.exit.cause);
          }
          yield* Effect.logError(
            `Executing step ${ended.record.stepId} of run ${runId} was interrupted, so the run fails`,
            ended.exit.cause,
          );
          yield* failRun(runId, ended.record, UNEXPECTED_RUN_FAILURE, "controller-error");
        }
      }),
    );

  /**
   * Fails a run that its execution could not carry out for a reason of the
   * controller's own, such as a database error or a bug, with
   * `controller-error` and no failed step: the error was not at any one step.
   */
  const failRunUnexpectedly = (runId: string): Effect.Effect<void, SqlError> =>
    withTransaction(
      sql,
      Effect.flatMap(nowIso, (at) =>
        writeRunEnding(runId, { status: "failed", failureReason: "controller-error" }, at),
      ),
    );

  /**
   * Fails a running run because its workspace or its runner failed, inside
   * the caller's transaction. When a workspace step of the run is running,
   * the run fails at it, with `workspace_failed` and `message`. Otherwise
   * the run fails with `workspace-failed` and no failed step, and `message`
   * is only logged: a run's ending has no field for it.
   */
  const failRunInWorkspace = (runId: string, message: string): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const at = yield* nowIso;
      const run = Option.getOrThrow(yield* runs.read(runId));
      const running = listNextStepRecords(run.steps).find(
        (record) => record.status === "running" && isWorkspaceStep(run.plan, record.stepId),
      );
      if (running !== undefined) {
        yield* writeStepFailure(
          runId,
          running,
          { code: "workspace_failed", message },
          "workspace-failed",
          at,
        );
        // No result from the runner ended this record, so the runner is told.
        return yield* settleWorkspaceSteps(run, [running]);
      }
      yield* Effect.logWarning(`Run ${runId} failed because its workspace failed: ${message}`);
      yield* writeRunEnding(runId, { status: "failed", failureReason: "workspace-failed" }, at);
    });

  /**
   * Fails the given running runs because their workspace failed, as
   * `failRunInWorkspace` fails each one. Once the transaction has committed,
   * the Run Executor stops their executions.
   *
   * It opens no transaction of its own: the caller runs it inside the
   * transaction that records why the workspace failed, so that failure and
   * the runs' failures commit together.
   */
  const failRunsWhoseWorkspaceFailed = (
    runIds: ReadonlyArray<string>,
    message: string,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      for (const runId of runIds) yield* failRunInWorkspace(runId, message);
      if (runIds.length > 0) yield* afterCommit(() => executor.stop(runIds));
    });

  // The runs domain's session observer fails an agent step whose turn no
  // runner will report through this handler (see `session-observer.ts`).
  // Once the transaction has committed, the Run Executor stops the run's
  // execution, which may still carry out a parallel controller step.
  stepSessionFailures.register(({ runId, record, message }) =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const at = yield* nowIso;
        yield* writeStepFailure(
          runId,
          record,
          { code: "session_failed", message },
          "session-failed",
          at,
        );
        yield* afterCommit(() => executor.stop([runId]));
      }),
    ),
  );

  /**
   * Decodes a workspace step's output against its action's output schema,
   * and returns it encoded again, as it is stored. Fails the result with
   * `unexpected` when the output does not match, and with `not_found` when
   * the action has left the catalog.
   */
  const decodeWorkspaceOutput = (
    run: Run,
    stepId: string,
    output: Schema.Json,
  ): Effect.Effect<Result.Result<Schema.Json, EngineStepError>> =>
    Effect.gen(function* () {
      const step = findActionStep(run, stepId);
      // The run has started, so its action is looked up in the full catalog,
      // as `executeStep` does.
      const action = yield* host.findWorkflowAction(step.action);
      if (Option.isNone(action)) return Result.fail(buildActionUnavailableError(step.action));
      // A step record stores JSON, so the output schema is read as one that
      // encodes to JSON.
      const schema = action.value.output as Schema.Codec<unknown, Schema.Json>;
      const decoded = Schema.decodeUnknownResult(schema)(output);
      if (Result.isFailure(decoded)) {
        return Result.fail<EngineStepError>({
          code: "unexpected",
          message: `The runner returned an output that does not match the output schema of ${step.action}: ${decoded.failure.message}`,
        });
      }
      return Result.succeed(Schema.encodeSync(schema)(decoded.success));
    });

  /**
   * Hands a run's execution to the Run Executor, which carries it out apart
   * from the caller unless it already carries out that run, and returns at
   * once. It is synchronous so that it can run right after a commit (see
   * `afterCommit`).
   *
   * If the execution fails for a reason of the controller's own, the run
   * fails with `controller-error`. If even that ending cannot be written, the
   * error is logged: the run then stays unfinished, and the next boot resumes
   * it. An execution that is stopped simply ends: the cancel that stopped it
   * has already written the run's ending.
   */
  const executeInBackground = (runId: string): void => {
    executor.execute(runId, (wakes) =>
      Effect.catchCause(executeRun(runId, wakes), (cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.andThen(
              Effect.logError(`Executing run ${runId} failed, so the run fails`, cause),
              Effect.catchCause(failRunUnexpectedly(runId), (failure) =>
                Cause.hasInterrupts(failure)
                  ? Effect.interrupt
                  : Effect.logError(`Failing run ${runId} failed`, failure),
              ),
            ),
      ).pipe(Effect.provideService(AfterCommit, afterCommitListener)),
    );
  };

  return {
    start,

    /** `run.rerun`: starts a new run that re-runs an ended one (see `start.ts`). */
    rerun,

    /** Writes the run of a start trigger that matched an event (see `start.ts`). */
    startTriggeredRun,

    /** Records an event that matched a run's signal trigger (see `signals.ts`). */
    recordSignalMatch,

    /**
     * `run.cancel`: cancels a pending or running run and returns it.
     *
     * One transaction cancels the run, every step record of it that has not
     * ended, and every unfinished run that its steps started, directly or
     * further down, with their step records. Then the Run Executor stops
     * their executions, which aborts the signal of a plugin action in
     * flight, and the workspace steps that were running are settled with
     * their runners, which stop them (see `writeRunEnding`). A step whose action ends after
     * the cancel cannot end its record any more, and no later step starts.
     *
     * `input.keepWorkspace` applies to the run and to every run cancelled
     * with it. Each of them releases its workspace lease as `inspection` when
     * it is set, which keeps an ephemeral workspace for the
     * `workspace.inspectionTtlDays` window from the cancel, and as `none`
     * otherwise, which lets the next sweep delete it once no other holder
     * keeps it.
     *
     * Fails with `Validation` for an input that does not match
     * `RunCancelInput`, with `NotFound` for an unknown run, and with
     * `InvalidState` for a run that has already ended.
     */
    cancel: (
      id: Id,
      input: RunCancelInput,
    ): Effect.Effect<
      Run,
      Unauthenticated | Forbidden | Validation | NotFound | InvalidState | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("run.cancel");
        const { keepWorkspace = false } = yield* Effect.mapError(
          decodeCancel(input),
          createDecodeValidationError,
        );
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const found = yield* runs.read(id);
            if (Option.isNone(found)) {
              return yield* Effect.fail(createNotFoundError("no such run"));
            }
            const { status } = found.value;
            if (!isUnfinished(status)) {
              return yield* Effect.fail(
                createInvalidStateError(
                  `the run ${describeEnding(status)}; only a pending or running run can be cancelled`,
                ),
              );
            }
            const at = yield* nowIso;
            const cancelled = [id, ...(yield* runs.listUnfinishedDescendants(id))];
            for (const runId of cancelled) {
              yield* writeRunEnding(runId, { status: "cancelled", keepWorkspace }, at);
            }
            yield* afterCommit(() => executor.stop(cancelled));
            // The same transaction found the run above, and runs are never
            // deleted.
            return Option.getOrThrow(yield* runs.read(id));
          }),
        );
      }),

    /**
     * Hands every run that is pending or running to the Run Executor, which
     * skips the ones it already carries out. The controller calls this when
     * it starts: the rows of a run that a restart cut off are all there is to
     * continue it from.
     */
    resumeUnfinished: Effect.map(runs.listUnfinished(), (ids) => {
      for (const runId of ids) executeInBackground(runId);
    }),

    /**
     * Ends a workspace step with the result its runner reported, and hands
     * the run's execution on once the transaction commits: a completed step
     * routes the run to its next steps, and a failed one fails the run at
     * the step. Joins the caller's transaction when there is one.
     *
     * A result that cannot apply is ignored, and logged, rather than
     * refused, because the runner can do nothing about it:
     *
     * - the run is unknown, has ended, or is not pinned to `runnerId`;
     * - the step is not a workspace step of the run;
     * - the record is not running, for example because the same result
     *   arrived twice, or the run was cancelled first.
     *
     * So the same result applies once however often it arrives.
     *
     * - An action step's output is decoded against the action's output
     *   schema, and one that does not match fails the step with
     *   `unexpected`. A failed action step fails the run with `step-failed`.
     * - An agent step's output is stored as the runner reported it: the
     *   runner has already checked it against the step's `outputSchema`. A
     *   failed agent step fails the run with the reason its code maps to
     *   (`decideAgentStepFailureReason`).
     */
    completeStep: (
      runnerId: string,
      result: Omit<WorkspaceStepResult, "_tag">,
    ): Effect.Effect<void, SqlError> =>
      Effect.provideService(
        Effect.gen(function* () {
          const { runId, stepId, iteration, outcome } = result;
          if (!UUID_PATTERN.test(runId)) {
            return yield* Effect.logDebug(
              `Ignored the result of step ${stepId} from runner ${runnerId}: ${runId} is not a run id`,
            );
          }
          yield* withTransaction(
            sql,
            Effect.gen(function* () {
              const found = yield* runs.read(runId);
              if (
                Option.isNone(found) ||
                found.value.runnerId !== runnerId ||
                !isWorkspaceStep(found.value.plan, stepId)
              ) {
                return yield* Effect.logWarning(
                  `Ignored the result of step ${stepId} of run ${runId} from runner ${runnerId}: the run is not pinned to that runner, or the step does not run in a workspace`,
                );
              }
              const run = found.value;
              const record = listNextStepRecords(run.steps).find(
                (candidate) => candidate.stepId === stepId && candidate.iteration === iteration,
              );
              if (record?.status !== "running") {
                return yield* Effect.logDebug(
                  `Ignored the result of step ${stepId} of run ${runId}: its record is not running`,
                );
              }
              const at = yield* nowIso;
              const agentStep = findAgentStep(run.plan, stepId);
              yield* afterCommit(() => executeInBackground(runId));
              if (outcome.status === "failed") {
                return yield* writeStepFailure(
                  runId,
                  record,
                  { code: outcome.code, message: outcome.message },
                  agentStep === undefined
                    ? "step-failed"
                    : decideAgentStepFailureReason(outcome.code),
                  at,
                );
              }
              let output = outcome.output;
              if (agentStep === undefined) {
                const decoded = yield* decodeWorkspaceOutput(run, stepId, outcome.output);
                if (Result.isFailure(decoded)) {
                  return yield* writeStepFailure(runId, record, decoded.failure, "step-failed", at);
                }
                output = decoded.success;
              }
              yield* runs.finishStep(
                runId,
                record,
                { status: "completed", output },
                { startedAt: record.startedAt, finishedAt: at },
              );
              yield* routeAfterStep(runId, stepId, at);
            }),
          );
        }).pipe(
          // The record was checked to be running in the same transaction, so
          // it cannot have ended in between.
          Effect.catchTag("StepRecordEnded", (ended) => Effect.die(ended)),
        ),
        AfterCommit,
        afterCommitListener,
      ),

    /**
     * Fails every running run that works in a workspace, because the
     * workspace failed: it could not be provisioned, or it broke. Each run
     * fails as `failRunsWhoseWorkspaceFailed` fails it.
     */
    failRunsInWorkspace: (workspaceId: string, message: string): Effect.Effect<void, SqlError> =>
      Effect.flatMap(runs.listWorkingIn(workspaceId), (runIds) =>
        failRunsWhoseWorkspaceFailed(runIds, message),
      ),

    /**
     * Fails every running run pinned to a runner, because the runner is gone
     * and its workspaces with it. Each run fails as
     * `failRunsWhoseWorkspaceFailed` fails it.
     */
    failRunsPinnedTo: (runnerId: string, message: string): Effect.Effect<void, SqlError> =>
      Effect.flatMap(runs.listPinnedTo(runnerId), (runIds) =>
        failRunsWhoseWorkspaceFailed(runIds, message),
      ),

    /**
     * Returns every workspace step still running on a runner, for the
     * controller daemon to send again when that runner connects:
     *
     * - an action step is sent with the input stored on its record, so it
     *   runs with the same input as the first time;
     * - an agent step is sent as a request for its result, but only once its
     *   prompt has left the controller. A prompt still waiting is delivered
     *   to the session as usual, and the runner reports the turn it starts.
     */
    listOwedWorkspaceSteps: (
      runnerId: string,
    ): Effect.Effect<ReadonlyArray<WorkspaceStepToStart>, SqlError> =>
      Effect.map(runs.listRunningStepsPinnedTo(runnerId), (records) =>
        records.flatMap((record): ReadonlyArray<WorkspaceStepToStart> => {
          const { runId, stepId, iteration, workspaceId } = record;
          if (record.kind === "agent") {
            return record.promptWaiting
              ? []
              : [
                  {
                    kind: "agent",
                    runId,
                    stepId,
                    iteration,
                    runnerId,
                    sessionId: record.sessionId,
                    workspaceId,
                  },
                ];
          }
          // A workspace action's record is only ever started with its input
          // stored, in its run's workspace, so a record without them is not
          // a workspace action's.
          const { action, input, workspacePolicy } = record;
          return !runsInWorkspace(action) || input === undefined || workspaceId === null
            ? []
            : [
                buildActionStepToStart(
                  { runId, stepId, iteration, runnerId, workspaceId, action, input },
                  workspacePolicy,
                ),
              ];
        }),
      ),

    /**
     * Returns the steps among `steps` that a runner reports it is running but
     * should not be: the run is unknown, has ended, or is not pinned to the
     * runner, or the step record is not running. The controller daemon
     * settles each one with the runner.
     */
    listEndedWorkspaceSteps: (
      runnerId: string,
      steps: ReadonlyArray<WorkspaceStepKey>,
    ): Effect.Effect<ReadonlyArray<WorkspaceStepToSettle>, SqlError> =>
      Effect.map(runs.listRunningStepsPinnedTo(runnerId), (records) => {
        const running = new Set(records.map(formatStepKey));
        return steps
          .filter((step) => !running.has(formatStepKey(step)))
          .map((step) => ({ runnerId, ...step }));
      }),

    /**
     * Hands every running run that is not pinned to a runner yet, and whose
     * plan has a workspace or an agent step, to the Run Executor, because a
     * runner may now be able to take it. The controller daemon calls this:
     *
     * - when a runner connects;
     * - when a connected runner may have become placeable, because it was
     *   undrained, is no longer reserved, or got more room (the runners
     *   domain publishes each as `placementsChanged`);
     * - when a runner is retired, so a run whose only capable runner was
     *   retired fails instead of waiting for it.
     *
     * A run with nothing waiting goes back to sleep at once.
     */
    wakeRunsWaitingForRunner: (): Effect.Effect<void, SqlError> =>
      Effect.map(runs.listRunsWaitingForRunner(), (ids) => {
        for (const runId of ids) executeInBackground(runId);
      }),
  };
});
