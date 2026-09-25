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
 * A workspace step, one whose action runs in the run's workspace on a runner
 * (such as `git.commit`), is different at steps 2 and 3:
 *
 * - The start transaction of the run's first workspace step pins the run to
 *   a runner and opens the run's workspace there. Every later workspace step
 *   of the run runs in that workspace. When no runner can take the run, the
 *   record stays pending and the run waits for a runner.
 * - After the start transaction commits, the step is handed to its runner
 *   through Workspace Steps (`workspace-steps.ts`), and the child fiber ends.
 *   No fiber waits for the step: its result arrives later from the runner
 *   (`completeStep`), and the end transaction runs then.
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
 * input when it connects, and runs it once. A plugin's action reaches outside
 * the controller, so its step record found `running` may or may not have
 * taken effect; runs never retry such an action, and the step fails with the
 * code `interrupted`. When several were running, the first fails and the run
 * cancels the others.
 *
 * Cancelling a run ends it, its unfinished step records, and every unfinished
 * run its steps started, directly or further down, in one transaction. Then
 * the Run Executor stops their executions, and the runners are asked to stop
 * the workspace steps that were running. A plugin's action in flight sees its
 * signal abort. An action that returns after the cancel cannot end its step
 * record any more, so the run stays cancelled and no later step starts.
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
  createInvalidStateError,
  createNotFoundError,
  Id,
  type FailureReason,
  type Forbidden,
  type InvalidState,
  type NotFound,
  type Run,
  type RunStatus,
  type StepError,
  type Unauthenticated,
  type WorkflowDefinition,
} from "@hercule/contract";
import type { WorkspaceStepKey, WorkspaceStepOutcome } from "@hercule/protocol";
import { CurrentActor, requireGrant, type RunActor } from "../actor";
import { AfterCommit, afterCommit, nowIso, UUID_PATTERN } from "../db";
import { isBuiltInControllerActionId, PluginHost, runsInWorkspace } from "../plugins";
import { runnerRepository } from "../runners";
import { isGitActionId } from "../workflows";
import { buildRunBranch, WorkspaceService } from "../workspaces";
import { RunExecutor } from "./executor";
import { runRepository, type RunOutcome, type StepRecordId } from "./repository";
import { decideRouting, isStepConditionMet } from "./routing";
import { makeRunStart } from "./start";
import {
  buildActionUnavailableError,
  findActionStep,
  makeStepExecution,
  type EngineStepError,
  type StepRecordKey,
} from "./step";
import { isUnfinished, listNextStepRecords, type UnfinishedStepRecord } from "./step-records";
import { commitUninterruptibly } from "./transaction";
import {
  WorkspaceSteps,
  type WorkspaceStepToStart,
  type WorkspaceStepToStop,
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

type WorkspacePolicy = NonNullable<WorkflowDefinition["workspace"]>;

/** The result of a workspace step as a runner reports it: the step's key and how it ended. */
export interface WorkspaceStepResult extends WorkspaceStepKey {
  readonly outcome: WorkspaceStepOutcome;
}

/**
 * What the start transaction did with a pending step record:
 *
 * - `started`: the record is `running` with `input` stored on it. For a
 *   workspace step, `workspaceStep` is what to hand to its runner once the
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
      readonly workspaceStep?: WorkspaceStepToStart;
    }
  | { readonly _tag: "ended" }
  | { readonly _tag: "waitsForRunner" };

const ENDED: StartedRecord = { _tag: "ended" };

const WAITS_FOR_RUNNER: StartedRecord = { _tag: "waitsForRunner" };

/**
 * What executing one step record did, as its child fiber reports it to the
 * run's execution: it ran its course, or it waits for a runner.
 */
type RecordProgress = "executed" | "waitsForRunner";

/** Checks whether a step of a plan is an action step whose action runs in the run's workspace. */
const isWorkspaceStep = (plan: WorkflowDefinition, stepId: string): boolean => {
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  return step?.kind === "action" && runsInWorkspace(step.action);
};

/** Returns the `resourceId` a step's input names, if it names one. */
const readResourceId = (input: Schema.Json): string | undefined => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const resourceId = (input as { readonly resourceId?: unknown }).resourceId;
  return typeof resourceId === "string" ? resourceId : undefined;
};

/** Returns the ids of the repos a run's workspace holds a checkout of. */
const listPolicyResourceIds = (policy: WorkspacePolicy): ReadonlyArray<string> =>
  policy.kind === "primary"
    ? [policy.resourceId]
    : policy.checkouts.map((checkout) => checkout.resourceId);

/**
 * Checks that a workspace step can run in the run's workspace, before a
 * runner is chosen or a workspace opened. Returns the error the step fails
 * with, or `undefined` when it can run. A git action needs a checkout to work
 * in: the workspace must have one, and a `resourceId` in its input must name
 * one of them. Saving the workflow refused the other mistakes it could see,
 * but a `resourceId` can come from a template, and an empty workspace is a
 * choice the author may make for other steps.
 */
const findWorkspaceStepError = (
  policy: WorkspacePolicy,
  action: string,
  input: Schema.Json,
): EngineStepError | undefined => {
  if (!isGitActionId(action)) return undefined;
  const resourceIds = listPolicyResourceIds(policy);
  if (resourceIds.length === 0) {
    return {
      code: "validation",
      message: `The run's workspace has no checkout, so the action ${action} has nothing to work in. Add a checkout to the workflow's workspace.`,
    };
  }
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
 * Returns the stops to send for the records of a run that were running when
 * the run ended: those of its workspace steps, on the runner the run is
 * pinned to. A run that was never pinned has no workspace step running.
 */
const listWorkspaceStepsToStop = (
  run: Run,
  wasRunning: ReadonlyArray<StepRecordId>,
): ReadonlyArray<WorkspaceStepToStop> => {
  const { runnerId } = run;
  if (runnerId === undefined) return [];
  return wasRunning
    .filter((record) => isWorkspaceStep(run.plan, record.stepId))
    .map((record) => ({ runnerId, runId: run.id, ...record }));
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
  const workspaces = yield* WorkspaceService;
  const runners = yield* runnerRepository;
  const host = yield* PluginHost;
  // The listener that publishes a committed change on the live topics. A
  // run's execution is carried out apart from the request that started it,
  // so the listener is provided to the execution here.
  const afterCommitListener = yield* AfterCommit;
  // A new run is handed to the Run Executor through a function the engine
  // defines below, which itself calls `start` for the `run.start` action, so
  // the reference is passed as a function.
  const start = yield* makeRunStart((runId) => executeInBackground(runId));

  /**
   * Ends a run: cancels every step record of it that is still pending or
   * running, and moves the run to `outcome`. Every way a run ends goes
   * through here, inside the transaction that decided it, so a reader never
   * sees an ended run with a step record still pending or running. Returns
   * the records that were running when they were cancelled.
   */
  const writeRunEnding = (
    runId: string,
    outcome: RunOutcome,
    at: string,
  ): Effect.Effect<ReadonlyArray<StepRecordId>, SqlError> =>
    Effect.tap(runs.cancelUnfinishedSteps(runId, at), () => runs.finish(runId, outcome, at));

  /**
   * Fails a run at one of its steps, inside the caller's transaction: the
   * step record fails with `error`, and the run fails with `failureReason`
   * (see `writeRunEnding`). A record that has already ended keeps its ending.
   */
  const writeStepFailure = (
    runId: string,
    attempt: StepRecordKey,
    error: StepError,
    failureReason: FailureReason,
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
    failureReason: FailureReason,
  ): Effect.Effect<void, SqlError> =>
    commitUninterruptibly(
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
   * Returns the runner a run's workspace goes on, or `undefined` when no
   * runner can take it now. Only a placeable runner is chosen: online,
   * active and not reserved. For a repo's main workspace, a runner that
   * already holds it ready is preferred, because the run can start there
   * without a fresh clone. Among equals the choice is the lowest id, so it
   * does not change from one try to the next.
   */
  const chooseRunner = (policy: WorkspacePolicy): Effect.Effect<string | undefined, SqlError> =>
    Effect.gen(function* () {
      const placeable = yield* runners.placeable();
      const holding =
        policy.kind === "primary"
          ? [...(yield* workspaces.listRunnersWithReadyPrimary(policy.resourceId))].filter(
              (runnerId) => placeable.has(runnerId),
            )
          : [];
      return [...(holding.length > 0 ? holding : placeable)].sort()[0];
    });

  /**
   * Makes sure a run has a workspace for one of its workspace steps, inside
   * the step's start transaction. A run that is already pinned keeps its
   * runner and workspace. Otherwise this chooses a runner, opens the run's
   * workspace there, and pins the run to both. Returns the runner and the
   * workspace, or the step's other fate:
   *
   * - `ended`: the step cannot run in this workspace (see
   *   `findWorkspaceStepError`), or the workspace cannot be opened, and the
   *   step and the run have failed;
   * - `waitsForRunner`: no runner can take the run now.
   */
  const placeWorkspaceStep = (
    run: Run,
    record: StepRecordKey,
    action: string,
    input: Schema.Json,
    at: string,
  ): Effect.Effect<
    | { readonly _tag: "placed"; readonly runnerId: string; readonly workspaceId: string }
    | StartedRecord,
    SqlError
  > =>
    Effect.gen(function* () {
      const policy = run.plan.workspace;
      if (policy === undefined) {
        const noWorkspace: EngineStepError = {
          code: "validation",
          message: `The action ${action} runs in the run's workspace, and the run's workflow has no workspace.`,
        };
        yield* writeStepFailure(run.id, record, noWorkspace, "step-failed", at);
        return ENDED;
      }
      const refused = findWorkspaceStepError(policy, action, input);
      if (refused !== undefined) {
        yield* writeStepFailure(run.id, record, refused, "step-failed", at);
        return ENDED;
      }
      if (run.runnerId !== undefined && run.workspaceId !== undefined) {
        return { _tag: "placed", runnerId: run.runnerId, workspaceId: run.workspaceId } as const;
      }
      const runnerId = yield* chooseRunner(policy);
      if (runnerId === undefined) return WAITS_FOR_RUNNER;
      const actor: RunActor = { _tag: "run", runId: run.id, stepId: record.stepId };
      const opened = yield* Effect.result(
        Effect.provideService(
          workspaces.openFor({
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
      commitUninterruptibly(
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
          const step = findActionStep(run, record.stepId);
          const prepared = yield* prepareInput(run, step);
          if (Result.isFailure(prepared)) {
            const { error, failureReason } = prepared.failure;
            yield* writeStepFailure(runId, record, error, failureReason, at);
            return ENDED;
          }
          const { input } = prepared.success;
          if (!runsInWorkspace(step.action)) {
            yield* runs.startStep(runId, record, input, at);
            return { _tag: "started", run, startedAt: at, input } as const;
          }
          const placed = yield* placeWorkspaceStep(run, record, step.action, input, at);
          if (placed._tag !== "placed") return placed;
          yield* runs.startStep(runId, record, input, at);
          const resourceId = readResourceId(input);
          return {
            _tag: "started",
            run,
            startedAt: at,
            input,
            workspaceStep: {
              runId,
              stepId: record.stepId,
              iteration: record.iteration,
              runnerId: placed.runnerId,
              workspaceId: placed.workspaceId,
              action: step.action,
              input,
              ...(resourceId === undefined ? {} : { resourceId }),
            },
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

  /**
   * Executes one step record of a run, on a child fiber of the run's
   * execution (see `executeRun`). A pending record is started first (see
   * `startStepRecord`). A running record is one a restart cut off, and only
   * a built-in action's record gets here that way: it is executed again.
   *
   * A workspace step is handed to its runner once its start transaction has
   * committed, and this returns without waiting for it to end. Returns
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
        if (record.status === "running") {
          yield* executeStep(run, record, record.input);
          return "executed" as const;
        }
        const started = yield* startStepRecord(run.id, record);
        if (started._tag === "waitsForRunner") return "waitsForRunner" as const;
        if (started._tag === "started") {
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
   * it, and its result wakes the run. A workspace step that waits for a
   * runner is tried again only after another child has made progress, or
   * when a runner arrives and wakes the run. When no child fiber is left and
   * the run still has such records, the execution returns and the run is
   * asleep.
   *
   * When the run has ended, the execution returns, and closing its scope
   * interrupts the child fibers still executing: a `wait` stops, and a
   * plugin's action sees its signal abort. Stopping the execution, when the
   * run is cancelled or the controller stops, interrupts them the same way.
   */
  const executeRun = (runId: string): Effect.Effect<void, SqlError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const endedChildren = yield* Queue.unbounded<{
          readonly record: UnfinishedStepRecord;
          readonly exit: Exit.Exit<RecordProgress, SqlError>;
        }>();
        // The steps whose record a child fiber is executing. Only this loop
        // changes the set, so it is never stale.
        const busySteps = new Set<string>();
        // The steps whose next record is a workspace step that found no
        // runner. They are not tried again until another child has made
        // progress, or the loop would try them over and over.
        const stepsWaitingForRunner = new Set<string>();
        for (;;) {
          const found = yield* runs.read(runId);
          if (Option.isNone(found)) return;
          const run = found.value;
          if (!isUnfinished(run.status)) return;
          if (run.status === "pending") {
            yield* commitUninterruptibly(
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
            busySteps.add(record.stepId);
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
          if (busySteps.size === 0) {
            // A run always has a pending or running record until it ends:
            // starting a run creates its entry records, and routing ends the
            // run in the same transaction that ends its last record. Runs
            // left without one by an earlier engine were completed by
            // migration 30. So a run here is a bug in the engine, and it
            // fails rather than completing with nothing to show.
            yield* Effect.logError(
              `Run ${runId} is still running but has no step record to execute. This is a bug in the run engine, so the run fails with controller-error.`,
            );
            return yield* failRunUnexpectedly(runId);
          }
          const ended = yield* Queue.take(endedChildren);
          busySteps.delete(ended.record.stepId);
          if (Exit.isSuccess(ended.exit)) {
            if (ended.exit.value === "waitsForRunner") {
              stepsWaitingForRunner.add(ended.record.stepId);
            } else {
              // Progress may have freed a runner, so the steps that found
              // none are tried again.
              stepsWaitingForRunner.clear();
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
    commitUninterruptibly(
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
        return yield* writeStepFailure(
          runId,
          running,
          { code: "workspace_failed", message },
          "workspace-failed",
          at,
        );
      }
      yield* Effect.logWarning(`Run ${runId} failed because its workspace failed: ${message}`);
      yield* writeRunEnding(runId, { status: "failed", failureReason: "workspace-failed" }, at);
    });

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
      const action = (yield* host.listActiveWorkflowActions()).find(
        (candidate) => candidate.id === step.action,
      );
      if (action === undefined) return Result.fail(buildActionUnavailableError(step.action));
      const schema = action.output as unknown as Schema.Codec<unknown, Schema.Json>;
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
    const execution = Effect.catchCause(executeRun(runId), (cause) =>
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
    );
    executor.execute(runId, Effect.provideService(execution, AfterCommit, afterCommitListener));
  };

  return {
    start,

    /**
     * `run.cancel`: cancels a pending or running run and returns it.
     *
     * One transaction cancels the run, every step record of it that has not
     * ended, and every unfinished run that its steps started, directly or
     * further down, with their step records. Then the Run Executor stops
     * their executions, which aborts the signal of a plugin action in
     * flight, and the runners are asked to stop the workspace steps that
     * were running. A step whose action ends after the cancel cannot end its
     * record any more, and no later step starts.
     *
     * Fails with `NotFound` for an unknown run, and with `InvalidState` for a
     * run that has already ended.
     */
    cancel: (
      id: Id,
    ): Effect.Effect<Run, Unauthenticated | Forbidden | NotFound | InvalidState | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("run.cancel");
        const toStop: Array<WorkspaceStepToStop> = [];
        const cancelledRun = yield* commitUninterruptibly(
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
              const run = Option.getOrThrow(yield* runs.read(runId));
              const wasRunning = yield* writeRunEnding(runId, { status: "cancelled" }, at);
              toStop.push(...listWorkspaceStepsToStop(run, wasRunning));
            }
            yield* afterCommit(() => executor.stop(cancelled));
            // The same transaction found the run above, and runs are never
            // deleted.
            return Option.getOrThrow(yield* runs.read(id));
          }),
        );
        if (toStop.length > 0) yield* workspaceSteps.stop(toStop);
        return cancelledRun;
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
     * the run's execution on: a completed step routes the run to its next
     * steps, and a failed one fails the run at the step.
     *
     * A result that cannot apply is ignored, and logged, rather than
     * refused, because the runner can do nothing about it:
     *
     * - the run is unknown, has ended, or is not pinned to `runnerId`;
     * - the step is not a workspace step of the run;
     * - the record is not running, for example because the same result
     *   arrived twice, or the run was cancelled first.
     *
     * An output that does not match the action's output schema fails the
     * step with `unexpected`.
     */
    completeStep: (runnerId: string, result: WorkspaceStepResult): Effect.Effect<void, SqlError> =>
      Effect.provideService(
        Effect.gen(function* () {
          const { runId, stepId, iteration, outcome } = result;
          if (!UUID_PATTERN.test(runId)) {
            return yield* Effect.logDebug(
              `Ignored the result of step ${stepId} from runner ${runnerId}: ${runId} is not a run id`,
            );
          }
          const applied = yield* commitUninterruptibly(
            sql,
            Effect.gen(function* () {
              const found = yield* runs.read(runId);
              if (
                Option.isNone(found) ||
                found.value.runnerId !== runnerId ||
                !isWorkspaceStep(found.value.plan, stepId)
              ) {
                yield* Effect.logWarning(
                  `Ignored the result of step ${stepId} of run ${runId} from runner ${runnerId}: the run is not pinned to that runner, or the step does not run in a workspace`,
                );
                return false;
              }
              const run = found.value;
              const record = listNextStepRecords(run.steps).find(
                (candidate) => candidate.stepId === stepId && candidate.iteration === iteration,
              );
              if (record?.status !== "running") {
                yield* Effect.logDebug(
                  `Ignored the result of step ${stepId} of run ${runId}: its record is not running`,
                );
                return false;
              }
              const at = yield* nowIso;
              if (outcome.status === "failed") {
                yield* writeStepFailure(
                  runId,
                  record,
                  { code: outcome.code, message: outcome.message },
                  "step-failed",
                  at,
                );
                return true;
              }
              const output = yield* decodeWorkspaceOutput(run, stepId, outcome.output);
              if (Result.isFailure(output)) {
                yield* writeStepFailure(runId, record, output.failure, "step-failed", at);
                return true;
              }
              yield* runs.finishStep(
                runId,
                record,
                { status: "completed", output: output.success },
                { startedAt: record.startedAt, finishedAt: at },
              );
              yield* routeAfterStep(runId, stepId, at);
              return true;
            }),
          );
          if (applied) executeInBackground(runId);
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
     * workspace failed: it could not be provisioned, or it broke. A run whose
     * workspace step is running fails at that step, with
     * `workspace_failed` and `message`; any other run fails with
     * `workspace-failed` and no failed step. Then their executions stop.
     */
    failWorkspace: (workspaceId: string, message: string): Effect.Effect<void, SqlError> =>
      Effect.provideService(
        Effect.gen(function* () {
          const failed = yield* commitUninterruptibly(
            sql,
            Effect.gen(function* () {
              const runIds = yield* runs.listWorkingIn(workspaceId);
              for (const runId of runIds) yield* failRunInWorkspace(runId, message);
              return runIds;
            }),
          );
          if (failed.length > 0) executor.stop(failed);
        }),
        AfterCommit,
        afterCommitListener,
      ),

    /**
     * Fails every running run pinned to a runner, inside the caller's
     * transaction, because the runner is gone and its workspaces with it.
     * Each run fails as `failWorkspace` fails it. Once the caller's
     * transaction has committed, their executions stop.
     */
    failRunsPinnedTo: (runnerId: string, message: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const runIds = yield* runs.listPinnedTo(runnerId);
        for (const runId of runIds) yield* failRunInWorkspace(runId, message);
        if (runIds.length > 0) yield* afterCommit(() => executor.stop(runIds));
      }),

    /**
     * Returns every workspace step still running on a runner, for the
     * controller daemon to send again when that runner connects. A step is
     * sent with the input stored on its record, so it runs with the same
     * input as the first time.
     */
    owedWorkspaceSteps: (
      runnerId: string,
    ): Effect.Effect<ReadonlyArray<WorkspaceStepToStart>, SqlError> =>
      Effect.map(runs.listRunningStepsPinnedTo(runnerId), (records) =>
        records.flatMap(({ input, ...record }) => {
          // A workspace step's record is only ever started with its input
          // stored, so a record without one is not a workspace step's.
          if (!runsInWorkspace(record.action) || input === undefined) return [];
          const resourceId = readResourceId(input);
          return [{ ...record, runnerId, input, ...(resourceId === undefined ? {} : { resourceId }) }];
        }),
      ),

    /**
     * Returns the steps among `steps` that a runner reports it is running but
     * should not be: the run is unknown, has ended, or is not pinned to the
     * runner, or the step record is not running. The controller daemon asks
     * the runner to stop each one.
     */
    listEndedWorkspaceSteps: (
      runnerId: string,
      steps: ReadonlyArray<WorkspaceStepKey>,
    ): Effect.Effect<ReadonlyArray<WorkspaceStepToStop>, SqlError> =>
      Effect.gen(function* () {
        const ended: Array<WorkspaceStepToStop> = [];
        for (const step of steps) {
          const found = UUID_PATTERN.test(step.runId)
            ? yield* runs.read(step.runId)
            : Option.none<Run>();
          const running =
            Option.isSome(found) &&
            found.value.status === "running" &&
            found.value.runnerId === runnerId &&
            found.value.steps.some(
              (record) =>
                record.stepId === step.stepId &&
                record.iteration === step.iteration &&
                record.status === "running",
            );
          if (!running) ended.push({ runnerId, ...step });
        }
        return ended;
      }),

    /**
     * Hands every running run that has a workspace but no runner yet to the
     * Run Executor, because a runner may now be able to take it. The
     * controller daemon calls this when a runner connects or becomes
     * placeable. A run with nothing waiting goes back to sleep at once.
     */
    wakeRunsWaitingForRunner: (): Effect.Effect<void, SqlError> =>
      Effect.map(runs.listUnpinnedWithWorkspace(), (ids) => {
        for (const runId of ids) executeInBackground(runId);
      }),
  };
});
