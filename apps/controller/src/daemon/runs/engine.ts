/**
 * The run engine: starts runs of workflows and executes their steps.
 *
 * A run is only rows (the runs domain). Starting a run (`start.ts`) writes the
 * run and a step record for each entry step, and returns. The engine then
 * executes the run on a fiber of its own:
 *
 * 1. It reads the run and takes its first step record that is pending, or
 *    running because a restart cut it off.
 * 2. It moves a pending record to `running`, in a transaction of its own.
 * 3. It renders the step's params from the run's inputs and the outputs of
 *    the steps that have completed, and decodes them with the action's input
 *    schema.
 * 4. It calls the action, and ends the step record and adds a pending record
 *    for each step an edge leads to. A built-in action is called as the run,
 *    in the same transaction that ends its record; `wait` is the exception,
 *    because it holds no transaction while it waits. A plugin's action is
 *    called outside any transaction, and its record ends afterwards.
 * 5. It repeats until no step record is pending or running, and then
 *    completes the run.
 *
 * A built-in action's effect and the end of its step record commit together,
 * so a crash never leaves the effect committed with the step still unfinished. A
 * failed step, or a template that cannot be rendered, fails the run and
 * cancels the step records that have not run.
 *
 * Nothing about a run is held only in memory. When the controller starts, it
 * resumes every run that is pending or running from its rows. A built-in
 * action's step record found `running` then is executed again: its action
 * calls the controller's own services, in the transaction that would have
 * ended the record, so a record still `running` means that transaction never
 * committed and the action took no effect. A `wait` step waits only for the
 * time it had left. A plugin's action reaches outside the controller, so its
 * step record found `running` may or may not have taken effect; runs never
 * retry such an action, and the step fails with the code `interrupted`.
 *
 * Cancelling a run ends it, its unfinished step records, and every unfinished
 * run its steps started, directly or further down, in one transaction. Then
 * it interrupts the fibers executing them. A plugin's action in flight sees
 * its signal abort. An action that returns after the cancel cannot end its
 * step record any more, so the run stays cancelled and no later step starts.
 *
 * If executing a run fails for a reason of the controller's own, such as a
 * database error or a bug, the run fails with `controller-error`, at its
 * current step if it has one, rather than staying `running` until the next
 * restart.
 *
 * A run executes its ready steps one at a time, in the order their records
 * were created. The actions it can call all write to the one database, so
 * running them side by side would not finish any sooner.
 */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { isSqlError, type SqlError } from "effect/unstable/sql/SqlError";
import {
  createDecodeValidationError,
  createInvalidStateError,
  createNotFoundError,
  formatIssue,
  Id,
  isApiError,
  listDecodeIssues,
  type FailureReason,
  type Forbidden,
  type InvalidState,
  type NotFound,
  type Run,
  type RunStartInput,
  type RunStatus,
  type StepError,
  type TaskCreateInput,
  type TaskFilter,
  type Unauthenticated,
  type Validation,
  type WorkflowDefinition,
} from "@hercule/contract";
import { ActionError, type WorkflowActionContribution } from "@hercule/plugin-host";
import { CurrentActor, requireGrant, type RunActor } from "../../actor";
import { AfterCommit, afterCommit, nowIso, withTransaction } from "../../db";
import { renderTemplates } from "../../expressions";
import {
  isBuiltInActionId,
  PluginHost,
  type BuiltInActionId,
  type RegisteredWorkflowAction,
} from "../../plugins";
import {
  findCurrentStepRecord,
  isUnfinished,
  runRepository,
  StepRecordEnded,
  type UnfinishedStepRecord,
} from "../../runs";
import type { Settings } from "../../settings";
import { TaskService } from "../../tasks";
import type { WorkflowService } from "../../workflows";
import { absorbFailures } from "../absorbing";
import { makeRunStart } from "./start";

const Identified = Schema.Struct({ id: Id });

/** The input of an operation on one run, named by its id. */
type Identified = Schema.Schema.Type<typeof Identified>;

const decodeIdentified = Schema.decodeUnknownEffect(Identified);

/**
 * The codes of the step errors the engine writes itself. A step whose action
 * failed keeps the action's own code instead: the code of an API error, such
 * as `not_found` or `cap_exceeded`, or the code of a plugin's `ActionError`.
 *
 * - `not_found`: the step's action is not in the catalog, or has nothing to
 *   call.
 * - `expression_error`: a template in the step's params could not be
 *   evaluated.
 * - `validation`: the rendered params do not match the action's input schema.
 * - `unexpected`: the action failed with something that is neither an API
 *   error nor an `ActionError`, such as a bug, or the controller could not
 *   carry out the run at this step.
 * - `interrupted`: the controller stopped while a plugin's action was
 *   running.
 */
type EngineStepErrorCode =
  "not_found" | "expression_error" | "validation" | "unexpected" | "interrupted";

/** A step error the engine writes itself. */
interface EngineStepError extends StepError {
  readonly code: EngineStepErrorCode;
}

/** The error of a step whose action is not in the catalog, or has nothing to call. */
const buildActionUnavailableError = (action: string): EngineStepError => ({
  code: "not_found",
  message: `The action ${action} is not available.`,
});

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

/** The step error for an action that failed with something other than one of the API's errors, such as a bug. */
const UNEXPECTED_FAILURE: EngineStepError = {
  code: "unexpected",
  message: "The action failed unexpectedly. The controller's log has the details.",
};

/** The step error for a plugin action's step record that a restart cut off while the action ran. */
const INTERRUPTED: EngineStepError = {
  code: "interrupted",
  message:
    "The controller stopped while this step's action was running, so it may or may not have taken effect. Runs never retry an action; start a new run if it is needed.",
};

/** One attempt at a step, as far as ending it needs: which step, which attempt, and when it started, if it has. */
interface StepAttempt {
  readonly stepId: string;
  readonly iteration: number;
  readonly startedAt?: string;
}

/**
 * A built-in action, as the engine calls it.
 *
 * `inTransaction` is true for an action whose effect commits in the
 * transaction that ends its step record. It is false for `wait`, which must
 * hold no transaction while it waits; its step record ends in a transaction
 * of its own afterwards.
 *
 * `execute` gets the step's params decoded with the action's input schema,
 * and the moment the step record started, which `wait` counts from.
 */
interface BuiltInActionHandler {
  readonly inTransaction: boolean;
  readonly execute: (
    input: unknown,
    step: { readonly startedAt: string },
  ) => Effect.Effect<unknown, unknown>;
}

/**
 * Returns the error a step record stores for a failed action: a plugin's
 * `ActionError` as it is, and one of the API's errors, the ones the built-in
 * actions' services fail with, as its code and message. Returns `undefined`
 * for anything else.
 */
const describeActionFailure = (failure: unknown): StepError | undefined => {
  if (failure instanceof ActionError) return { code: failure.code, message: failure.message };
  if (!isApiError(failure)) return undefined;
  const { code, message } = failure.error;
  const issues = failure.error.code === "validation" ? failure.error.details.issues : [];
  return {
    code,
    message: issues.length === 0 ? message : `${message}: ${issues.map(formatIssue).join("; ")}`,
  };
};

/**
 * Calls a plugin's action with a signal that aborts when the run is
 * cancelled, and returns its result encoded with the action's output schema.
 * Fails with the action's `ActionError`, or with an `ActionError` of code
 * `unexpected` when the result does not match the output schema: later steps
 * read the output, so a result of the wrong shape must not be stored as if
 * the step had succeeded.
 *
 * Cancelling a run interrupts the fiber that executes it, and the signal
 * passes that on to whatever the action waits on outside the controller.
 */
const executePluginAction = (
  action: RegisteredWorkflowAction,
  execute: WorkflowActionContribution["execute"],
  input: unknown,
  run: { readonly runId: string; readonly stepId: string },
): Effect.Effect<unknown, ActionError> =>
  Effect.suspend(() => {
    const cancelled = new AbortController();
    return Effect.flatMap(
      Effect.onInterrupt(execute(input, { run, signal: cancelled.signal }), () =>
        Effect.sync(() => cancelled.abort()),
      ),
      (output) =>
        Effect.mapError(
          Schema.encodeUnknownEffect(action.output as Schema.Codec<unknown>)(output),
          (error) =>
            new ActionError({
              code: "unexpected",
              message: `The action returned a value that does not match its output schema: ${listDecodeIssues(error).map(formatIssue).join("; ")}`,
            }),
        ),
    );
  });

/** Describes how a run ended, for the refusal to cancel it. */
const describeEnding = (status: RunStatus): string =>
  status === "cancelled" ? "has already been cancelled" : `has already ${status}`;

/** Returns the ids of the steps an edge from `stepId` leads to, in definition order. */
const listNextStepIds = (plan: WorkflowDefinition, stepId: string): ReadonlyArray<string> =>
  (plan.edges ?? []).filter((edge) => edge.from === stepId).map((edge) => edge.to);

/**
 * Returns the context a template is rendered against: the run's inputs, and
 * the output of each step that has completed.
 */
const buildRenderContext = (run: Run): Record<string, unknown> => ({
  inputs: run.inputs,
  steps: Object.fromEntries(
    run.steps.flatMap((record) =>
      record.status === "completed" ? [[record.stepId, { output: record.output }]] : [],
    ),
  ),
});

/**
 * Waits `seconds` from `startedAt`, and returns `{}`. A step that a restart
 * cut off waits only for the time it had left, and not at all if that time
 * has passed. Cancelling the run interrupts the wait.
 */
const waitFrom = (startedAt: string, seconds: number): Effect.Effect<Record<string, never>> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const remaining = Date.parse(startedAt) + seconds * 1000 - now;
    yield* Effect.sleep(Duration.millis(Math.max(0, remaining)));
    return {};
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runs = yield* runRepository;
  const tasks = yield* TaskService;
  const host = yield* PluginHost;
  // The listener that publishes a committed change on the live topics. A run
  // executes on a fiber of the engine's own, not of the request that started
  // it, so the listener is provided to that fiber here.
  const afterCommitListener = yield* AfterCommit;
  /** The fiber executing each run, by run id. A run has at most one. */
  const runFibers = yield* FiberMap.make<string>();
  const forkRun = yield* FiberMap.runtime(runFibers)<never>();
  // The fiber that executes a new run is started through a function the
  // engine defines below, which itself calls `startRun` for the `run.start`
  // action, so the reference is passed as a function.
  const startRun = yield* makeRunStart((runId) => executeInBackground(runId));

  /**
   * Runs one of a run's write sets in a transaction that cannot be
   * interrupted. Cancelling a run interrupts the fiber executing it, and an
   * interrupt that landed after the commit and before the transaction's
   * after-commit work would lose that work: the live announcements, and the
   * start of a child run that a `run.start` step committed. The write set
   * only touches the local database, so the interrupt waits a moment at most.
   */
  const commitUninterruptibly = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.uninterruptible(withTransaction(sql, effect));

  /**
   * The built-in actions, by id. Each but `wait` calls the same service
   * method as the operation of the same id, so a step can do nothing an API
   * request cannot.
   *
   * They are here rather than on the action catalog's entries (plugins
   * domain) because an action's code must reach the domain it acts on, and
   * the catalog sits below those domains. The `run.start` action starts a
   * run, which only this engine can do, and no domain may import the
   * controller daemon.
   */
  const builtInActions: Record<BuiltInActionId, BuiltInActionHandler> = {
    "task.create": {
      inTransaction: true,
      execute: (input) => tasks.create(input as TaskCreateInput),
    },
    "task.update": {
      inTransaction: true,
      execute: (input) => {
        // A request sends the task id in the path; a step has no path, so it
        // sends the id as taskId.
        const { taskId, ...fields } = input as { readonly taskId: string };
        return tasks.update({ id: taskId, ...fields });
      },
    },
    // The action returns the first page. A step reads it to decide what the
    // run does next, and the first page is enough for that.
    "task.query": { inTransaction: true, execute: (input) => tasks.query(input as TaskFilter) },
    "run.start": { inTransaction: true, execute: (input) => startRun(input as RunStartInput) },
    wait: {
      inTransaction: false,
      execute: (input, step) =>
        waitFrom(step.startedAt, (input as { readonly seconds: number }).seconds),
    },
  };

  /**
   * Fails a run at one of its steps: the step record fails with `error`,
   * every other record that has not run is cancelled, and the run fails with
   * `failureReason`. One transaction, so a reader never sees a failed run with
   * a step still pending. A record that has already ended keeps its ending.
   */
  const failRun = (
    runId: string,
    attempt: StepAttempt,
    error: StepError,
    failureReason: FailureReason,
  ): Effect.Effect<void, SqlError> =>
    commitUninterruptibly(
      Effect.gen(function* () {
        const at = yield* nowIso;
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
        yield* runs.cancelUnfinishedSteps(runId, at);
        yield* runs.finish(
          runId,
          { status: "failed", failureReason, failedStepId: attempt.stepId },
          at,
        );
      }),
    );

  /**
   * Executes one pending or running step record of a run, and records how it
   * ended. A failure of the step fails the run. This effect itself fails
   * only with a database error, which is the controller's failure rather
   * than the step's. Does nothing if the step record ended before its action
   * was called, because the run was cancelled.
   *
   * A built-in action's effect and the end of its step record commit in one
   * transaction, except for `wait`. A plugin's action reaches outside the
   * controller, so it is called after its record's `running` commits and
   * outside any transaction, and its record ends in a transaction of its own.
   */
  const executeStep = (run: Run, current: UnfinishedStepRecord): Effect.Effect<void, SqlError> =>
    Effect.catchTag(
      Effect.gen(function* () {
        // Starting the run checked that every step is an action step, and
        // the plan never changes.
        const step = run.plan.steps.find((candidate) => candidate.id === current.stepId);
        if (step === undefined || step.kind !== "action") {
          return yield* Effect.die(
            `the plan of run ${run.id} has no action step ${current.stepId}`,
          );
        }
        const startedAt = current.status === "running" ? current.startedAt : yield* nowIso;
        const attempt: StepAttempt = { ...current, startedAt };
        if (current.status === "pending") {
          yield* commitUninterruptibly(runs.startStep(run.id, attempt, startedAt));
        }
        const rendered = yield* Effect.result(
          renderTemplates(step.params ?? {}, buildRenderContext(run)),
        );
        if (Result.isFailure(rendered)) {
          return yield* failRun(
            run.id,
            attempt,
            { code: "expression_error", message: rendered.failure.message },
            "expression-error",
          );
        }
        const catalogEntry = (yield* host.listActiveWorkflowActions()).find(
          (action) => action.id === step.action,
        );
        if (catalogEntry === undefined) {
          return yield* failRun(
            run.id,
            attempt,
            buildActionUnavailableError(step.action),
            "step-failed",
          );
        }
        const decoded = Schema.decodeUnknownResult(catalogEntry.input as Schema.Codec<unknown>)(
          rendered.success,
          { errors: "all", onExcessProperty: "error" },
        );
        if (Result.isFailure(decoded)) {
          return yield* failRun(
            run.id,
            attempt,
            {
              code: "validation",
              message: `The rendered params do not match the action's input: ${listDecodeIssues(decoded.failure).map(formatIssue).join("; ")}`,
            },
            "step-failed",
          );
        }
        const actor: RunActor = { _tag: "run", runId: run.id, stepId: attempt.stepId };
        const completeStep = (output: unknown) =>
          Effect.gen(function* () {
            const finishedAt = yield* nowIso;
            yield* runs.finishStep(
              run.id,
              attempt,
              { status: "completed", output },
              { startedAt, finishedAt },
            );
            yield* runs.insertSteps(run.id, listNextStepIds(run.plan, attempt.stepId), finishedAt);
          });
        // Returns the error to fail the step with, or `undefined` when
        // something else ended the step while its action ran, such as a
        // cancel. That ending stands, and a built-in action's effect rolled
        // back with its transaction. A database error is the controller's
        // failure, not the action's, so it fails this effect instead.
        const decideStepError = (
          cause: Cause.Cause<unknown>,
        ): Effect.Effect<StepError | undefined, SqlError> => {
          if (Cause.hasInterrupts(cause)) return Effect.interrupt;
          const error = Option.getOrUndefined(Cause.findErrorOption(cause));
          if (error instanceof StepRecordEnded) return Effect.succeed(undefined);
          if (isSqlError(error)) return Effect.fail(error);
          const described = describeActionFailure(error);
          return described === undefined
            ? Effect.as(
                Effect.logError(`Step ${attempt.stepId} of run ${run.id} failed`, cause),
                UNEXPECTED_FAILURE,
              )
            : Effect.succeed(described);
        };
        // A built-in action is called through the engine's own handlers, and
        // a plugin's action through the `execute` its plugin registered.
        const builtIn = isBuiltInActionId(step.action) ? builtInActions[step.action] : undefined;
        const pluginExecute = catalogEntry.execute;
        let execute: Effect.Effect<void, unknown>;
        if (builtIn !== undefined) {
          const called = Effect.provideService(
            builtIn.execute(decoded.success, { startedAt }),
            CurrentActor,
            actor,
          );
          execute = builtIn.inTransaction
            ? commitUninterruptibly(Effect.flatMap(called, completeStep))
            : Effect.flatMap(called, (output) => commitUninterruptibly(completeStep(output)));
        } else if (pluginExecute !== undefined) {
          execute = Effect.flatMap(
            executePluginAction(catalogEntry, pluginExecute, decoded.success, {
              runId: run.id,
              stepId: attempt.stepId,
            }),
            (output) => commitUninterruptibly(completeStep(output)),
          );
        } else {
          return yield* failRun(
            run.id,
            attempt,
            buildActionUnavailableError(step.action),
            "step-failed",
          );
        }
        const failure = yield* Effect.catchCause(Effect.as(execute, undefined), decideStepError);
        if (failure !== undefined) yield* failRun(run.id, attempt, failure, "step-failed");
      }),
      "StepRecordEnded",
      () => Effect.void,
    );

  /**
   * Executes a run from its rows until it has ended. Reads the run again
   * after each step, because each step adds the records of the steps after it.
   */
  const executeRun = (runId: string): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      for (;;) {
        const found = yield* runs.read(runId);
        if (Option.isNone(found)) return;
        const run = found.value;
        if (!isUnfinished(run.status)) return;
        if (run.status === "pending") {
          yield* commitUninterruptibly(Effect.flatMap(nowIso, (at) => runs.start(runId, at)));
        }
        const current = findCurrentStepRecord(run.steps);
        if (current === undefined) {
          return yield* commitUninterruptibly(
            Effect.flatMap(nowIso, (at) => runs.finish(runId, { status: "completed" }, at)),
          );
        }
        const step = run.plan.steps.find((candidate) => candidate.id === current.stepId);
        if (
          current.status === "running" &&
          !(step?.kind === "action" && isBuiltInActionId(step.action))
        ) {
          return yield* failRun(runId, current, INTERRUPTED, "step-failed");
        }
        yield* executeStep(run, current);
      }
    });

  /**
   * Fails a run that could not be carried out for a reason of the
   * controller's own, such as a database error or a bug, with
   * `controller-error`: at its current step, which fails with the code
   * `unexpected`, or as a whole if no step is current.
   */
  const failRunUnexpectedly = (runId: string): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const found = yield* runs.read(runId);
      if (Option.isNone(found)) return;
      const current = findCurrentStepRecord(found.value.steps);
      if (current !== undefined) {
        return yield* failRun(runId, current, UNEXPECTED_RUN_FAILURE, "controller-error");
      }
      yield* commitUninterruptibly(
        Effect.flatMap(nowIso, (at) =>
          runs.finish(runId, { status: "failed", failureReason: "controller-error" }, at),
        ),
      );
    });

  /**
   * Starts executing a run on a fiber of the engine's own, unless a fiber
   * already executes it, and returns at once. It is synchronous so that it
   * can run right after a commit (see `afterCommit`).
   *
   * A forked fiber starts running on the caller's thread until its first
   * wait, and a step's database work never waits. The fiber therefore yields
   * first, so the request that started the run is answered before any step
   * runs, rather than after the whole run.
   */
  const executeInBackground = (runId: string): void => {
    const execution = Effect.catchCause(
      Effect.andThen(Effect.yieldNow, executeRun(runId)),
      (cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.andThen(
              Effect.logError(`Executing run ${runId} failed, so the run fails`, cause),
              absorbFailures(`Failing run ${runId} failed`, failRunUnexpectedly(runId)),
            ),
    );
    forkRun(runId, Effect.provideService(execution, AfterCommit, afterCommitListener), {
      onlyIfMissing: true,
    });
  };

  /**
   * Stops the fiber executing a run, if one is, without waiting for it to
   * stop. It is synchronous so that it can run right after a commit.
   */
  const stopExecuting = (runId: string): void => {
    const fiber = FiberMap.getUnsafe(runFibers, runId);
    if (Option.isSome(fiber)) fiber.value.interruptUnsafe();
  };

  return {
    startRun,

    /**
     * `run.cancel`: cancels a pending or running run and returns it.
     *
     * One transaction cancels the run, every step record of it that has not
     * ended, and every unfinished run that its steps started, directly or
     * further down, with their step records. Then the fibers executing those
     * runs are interrupted, which aborts the signal of a plugin action in
     * flight. A step whose action ends after the cancel cannot end its record
     * any more, and no later step starts.
     *
     * Fails with `NotFound` for an unknown run, and with `InvalidState` for a
     * run that has already ended.
     */
    cancelRun: (
      input: Identified,
    ): Effect.Effect<
      Run,
      Unauthenticated | Forbidden | Validation | NotFound | InvalidState | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("run.cancel");
        const { id } = yield* Effect.mapError(decodeIdentified(input), createDecodeValidationError);
        return yield* Effect.uninterruptible(
          withTransaction(
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
                yield* runs.cancelUnfinishedSteps(runId, at);
                yield* runs.finish(runId, { status: "cancelled" }, at);
              }
              yield* afterCommit(() => {
                for (const runId of cancelled) stopExecuting(runId);
              });
              // The same transaction found the run above, and runs are never
              // deleted.
              return Option.getOrThrow(yield* runs.read(id));
            }),
          ),
        );
      }),

    /**
     * Resumes every run that is pending or running and has no fiber executing
     * it. The controller calls this when it starts: the rows of a run that a
     * restart cut off are all there is to continue it from.
     */
    resumeUnfinishedRuns: Effect.map(runs.listUnfinished(), (ids) => {
      for (const runId of ids) executeInBackground(runId);
    }),
  };
});

/** The run engine: starts runs and executes their steps. */
export class RunEngine extends Context.Service<RunEngine, Effect.Success<typeof make>>()(
  "hercule/controller/daemon/RunEngine",
) {}

export const RunEngineLayer: Layer.Layer<
  RunEngine,
  never,
  SqlClient.SqlClient | WorkflowService | TaskService | PluginHost | Settings | AfterCommit
> = Layer.effect(RunEngine)(make);

/**
 * Resumes every unfinished run, as the controller does when it starts
 * serving. A resume that cannot even list the runs is a broken database, which
 * nothing after it could work around, so it dies.
 */
export const resumeUnfinishedRuns: Effect.Effect<void, never, RunEngine> = Effect.orDie(
  Effect.flatMap(RunEngine, (engine) => engine.resumeUnfinishedRuns),
);
