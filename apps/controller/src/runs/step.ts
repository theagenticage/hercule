/**
 * Executing one step record of a run: rendering the step's params, calling
 * its action, and ending the record with what the action returned or how it
 * failed. The run engine (`engine.ts`) calls this on the child fiber that
 * executes the record, after the record has moved to `running`.
 */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { isSqlError, type SqlError } from "effect/unstable/sql/SqlError";
import {
  formatIssue,
  isApiError,
  listDecodeIssues,
  type FailureReason,
  type Run,
  type RunStarted,
  type RunStartInput,
  type StepError,
  type TaskCreateInput,
  type TaskFilter,
} from "@hercule/contract";
import { ActionError, type WorkflowActionContribution } from "@hercule/plugin-host";
import { CurrentActor, type RunActor } from "../actor";
import { nowIso } from "../db";
import { renderTemplates } from "../expressions";
import {
  isBuiltInActionId,
  PluginHost,
  type BuiltInActionId,
  type RegisteredWorkflowAction,
} from "../plugins";
import { TaskService } from "../tasks";
import { runRepository, StepRecordEnded } from "./repository";
import { buildRunContext } from "./run-context";
import type { RunStartError } from "./start";
import { commitUninterruptibly } from "./transaction";

/**
 * The codes of the step errors the engine writes itself. A step whose action
 * failed keeps the action's own code instead: the code of an API error, such
 * as `not_found` or `cap_exceeded`, or the code of a plugin's `ActionError`.
 *
 * - `not_found`: the step's action is not in the catalog, or has nothing to
 *   call.
 * - `expression_error`: the step's condition, or a template in its params,
 *   could not be evaluated, or the condition gave something other than true
 *   or false.
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
export interface EngineStepError extends StepError {
  readonly code: EngineStepErrorCode;
}

/**
 * Identifies one step record of a run: its step and its iteration. It also
 * carries when the record started, if it has, because ending the record
 * needs that time.
 */
export interface StepRecordKey {
  readonly stepId: string;
  readonly iteration: number;
  readonly startedAt?: string;
}

/** The error of a step whose action is not in the catalog, or has nothing to call. */
const buildActionUnavailableError = (action: string): EngineStepError => ({
  code: "not_found",
  message: `The action ${action} is not available.`,
});

/** The step error for an action that failed with something other than one of the API's errors, such as a bug. */
const UNEXPECTED_ACTION_FAILURE: EngineStepError = {
  code: "unexpected",
  message: "The action failed unexpectedly. The controller's log has the details.",
};

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

/** What executing a step needs from the run engine that calls it. */
interface StepExecutionNeeds {
  /** `run.start`, which the `run.start` action calls as the run. */
  readonly start: (input: RunStartInput) => Effect.Effect<RunStarted, RunStartError>;
  /** Fails the run at a step, in a transaction of its own. */
  readonly failRun: (
    runId: string,
    attempt: StepRecordKey,
    error: StepError,
    failureReason: FailureReason,
  ) => Effect.Effect<void, SqlError>;
  /** Routes the run after a step's record ended, inside the caller's transaction. */
  readonly routeAfterStep: (
    runId: string,
    stepId: string,
    at: string,
  ) => Effect.Effect<void, SqlError>;
}

/**
 * Builds `executeStep`, which executes one running step record of a run and
 * records how it ended.
 */
export const makeStepExecution = ({ start, failRun, routeAfterStep }: StepExecutionNeeds) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runs = yield* runRepository;
    const tasks = yield* TaskService;
    const host = yield* PluginHost;

    /**
     * The built-in actions, by id. Each but `wait` calls the same service
     * method as the operation of the same id, so a step can do nothing an API
     * request cannot.
     *
     * They are here rather than on the action catalog's entries (plugins
     * domain) because an action's code must reach the domain it acts on, and
     * the catalog sits below those domains. The runs domain sits above tasks
     * in the domain graph, so it calls the task service directly.
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
      "run.start": { inTransaction: true, execute: (input) => start(input as RunStartInput) },
      wait: {
        inTransaction: false,
        execute: (input, step) =>
          waitFrom(step.startedAt, (input as { readonly seconds: number }).seconds),
      },
    };

    /**
     * Executes one running step record of a run, and records how it ended. A
     * failure of the step fails the run. This effect itself fails only with a
     * database error, which is the controller's failure rather than the
     * step's. Does nothing more once the step record has ended some other way,
     * for example because the run was cancelled.
     *
     * A built-in action's effect and the end of its step record commit in one
     * transaction, except for `wait`. A plugin's action reaches outside the
     * controller, so it is called after its record's `running` commits and
     * outside any transaction, and its record ends in a transaction of its own.
     */
    return (run: Run, attempt: Required<StepRecordKey>): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        // Starting the run checked that every step is an action step, and
        // the plan never changes.
        const step = run.plan.steps.find((candidate) => candidate.id === attempt.stepId);
        if (step === undefined || step.kind !== "action") {
          return yield* Effect.die(
            `the plan of run ${run.id} has no action step ${attempt.stepId}`,
          );
        }
        const { startedAt } = attempt;
        const rendered = yield* Effect.result(
          renderTemplates(step.params ?? {}, buildRunContext(run)),
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
            yield* routeAfterStep(run.id, attempt.stepId, finishedAt);
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
                UNEXPECTED_ACTION_FAILURE,
              )
            : Effect.succeed(described);
        };
        // A built-in action is called through the handlers above, and a
        // plugin's action through the `execute` its plugin registered.
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
            ? commitUninterruptibly(sql, Effect.flatMap(called, completeStep))
            : Effect.flatMap(called, (output) => commitUninterruptibly(sql, completeStep(output)));
        } else if (pluginExecute !== undefined) {
          execute = Effect.flatMap(
            executePluginAction(catalogEntry, pluginExecute, decoded.success, {
              runId: run.id,
              stepId: attempt.stepId,
            }),
            (output) => commitUninterruptibly(sql, completeStep(output)),
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
      });
  });
