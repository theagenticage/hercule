/**
 * Executing one step record of a run that runs on the controller: preparing
 * the step's input, calling its action, and ending the record with what the
 * action returned or how it failed.
 *
 * The run engine (`engine.ts`) prepares the input in the transaction that
 * moves the record to `running`, and stores it on the record. It then calls
 * `executeStep` on the child fiber that executes the record. A step whose
 * action runs in the run's workspace is prepared the same way, but a runner
 * executes it, not this module.
 *
 * A plugin's action may act through a Connection. The step names the
 * Connection in its `connection` param, and the stored input keeps that id
 * beside the action's own input. Just before the action runs, `executeStep`
 * reads the Connection's credentials and hands them to the action. They are
 * never stored on the step record.
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
  isId,
  listDecodeIssues,
  type Run,
  type RunStarted,
  type WorkflowDefinition,
  type RunStartCall,
  type RunStartInput,
  type StepError,
  type TaskCreateInput,
  type NotificationCreateInput,
  type TaskFilter,
  type TaskUpdateCall,
} from "@hercule/contract";
import {
  ActionError,
  type ActionContext,
  type WorkflowActionContribution,
} from "@hercule/plugin-host";
import { buildRunActor, CurrentActor } from "../actor";
import { connectionRepository, ConnectionTypes } from "../connections";
import { nowIso, withTransaction } from "../db";
import { renderTemplates } from "../expressions";
import {
  CONNECTION_PARAM,
  isBuiltInControllerActionId,
  PluginHost,
  separateConnectionParam,
  type BuiltInControllerActionId,
  type RegisteredWorkflowAction,
} from "../plugins";
import { Notifier } from "../notifications";
import { TaskService } from "../tasks";
import { runRepository, StepRecordEnded, type ExecutionFailureReason } from "./repository";
import { buildRunContext } from "./run-context";
import type { RunStartError } from "./start";

/**
 * The codes of the step errors the engine writes itself. A step whose action
 * failed keeps the action's own code instead: the code of an API error, such
 * as `not_found` or `cap_exceeded`, or the code of a plugin's `ActionError`.
 *
 * - `not_found`: the step's action is not in the catalog, or has nothing to
 *   call.
 * - `expression_error`: the step's condition, a template in its params, or
 *   an agent step's prompt could not be evaluated, or the condition gave
 *   something other than true or false.
 * - `validation`: the rendered params do not match the action's input schema,
 *   or the step names a Connection of another type than its action acts
 *   through.
 * - `connection_unavailable`: the Connection the step acts through is
 *   disabled, or its credentials could not be read, for example because its
 *   access token could not be refreshed.
 * - `unexpected`: the action failed with something that is neither an API
 *   error nor an `ActionError`, such as a bug, or the controller could not
 *   carry out the run at this step.
 * - `interrupted`: the controller stopped while a plugin's action was
 *   running.
 * - `workspace_failed`: the run's workspace could not be set up, or the
 *   runner that holds it is gone, while the step was running in it.
 * - `session_failed`: an agent step's session could not be opened, or it
 *   ended while the step's turn was owed, with no runner left to report how
 *   the turn ended.
 */
type EngineStepErrorCode =
  | "not_found"
  | "expression_error"
  | "validation"
  | "connection_unavailable"
  | "unexpected"
  | "interrupted"
  | "workspace_failed"
  | "session_failed";

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

type ActionStep = Extract<WorkflowDefinition["steps"][number], { readonly kind: "action" }>;

/** The error of a step whose action is not in the catalog, or has nothing to call. */
export const buildActionUnavailableError = (action: string): EngineStepError => ({
  code: "not_found",
  message: `The action ${action} is not available.`,
});

/** Why a step's input could not be prepared: the step error, and the reason the run fails. */
export interface InputFailure {
  readonly error: EngineStepError;
  readonly failureReason: ExecutionFailureReason;
}

/**
 * Returns the action step of a run's plan with this id. Throws when there is
 * none, which the calling effect turns into a defect: the plan never changes,
 * so a missing step is a bug.
 */
export const findActionStep = (run: Run, stepId: string): ActionStep => {
  // Starting the run checked that every step is an action step, and the plan
  // never changes.
  const step = run.plan.steps.find((candidate) => candidate.id === stepId);
  if (step === undefined || step.kind !== "action") {
    throw new Error(`the plan of run ${run.id} has no action step ${stepId}`);
  }
  return step;
};

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
 * cancelled, and with the Connection it acts through, if any. Returns its
 * result encoded with the action's output schema.
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
  context: Pick<ActionContext, "run" | "connection">,
): Effect.Effect<unknown, ActionError> =>
  Effect.suspend(() => {
    const cancelled = new AbortController();
    return Effect.flatMap(
      Effect.onInterrupt(execute(input, { ...context, signal: cancelled.signal }), () =>
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
    failureReason: ExecutionFailureReason,
  ) => Effect.Effect<void, SqlError>;
  /** Routes the run after a step's record ended, inside the caller's transaction. */
  readonly routeAfterStep: (
    runId: string,
    stepId: string,
    at: string,
  ) => Effect.Effect<void, SqlError>;
}

/**
 * Builds `prepareInput`, which prepares a step's input, and `executeStep`,
 * which executes one running step record of a run and records how it ended.
 */
export const makeStepExecution = ({ start, failRun, routeAfterStep }: StepExecutionNeeds) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runs = yield* runRepository;
    const tasks = yield* TaskService;
    const notifier = yield* Notifier;
    const host = yield* PluginHost;
    const connections = yield* connectionRepository;
    const connectionTypes = yield* ConnectionTypes;

    /**
     * The built-in actions, by id. Each but `wait` calls the same service
     * method as the operation of the same id, so a step can do nothing an API
     * request cannot.
     *
     * They are here rather than on the action catalog's entries (plugins
     * domain) because an action's code must reach the domain it acts on, and
     * the catalog sits below those domains. The runs domain sits above tasks
     * and notifications in the domain graph, so it calls their services
     * directly.
     */
    const builtInActions: Record<BuiltInControllerActionId, BuiltInActionHandler> = {
      "task.create": {
        inTransaction: true,
        execute: (input) => tasks.create(input as TaskCreateInput),
      },
      "task.update": {
        inTransaction: true,
        execute: (input) => {
          // A request sends the task id in the path; a step has no path, so it
          // sends the id as taskId.
          const { taskId, ...fields } = input as TaskUpdateCall;
          return tasks.update({ id: taskId, ...fields });
        },
      },
      // The action returns the first page. A step reads it to decide what the
      // run does next, and the first page is enough for that.
      "task.query": { inTransaction: true, execute: (input) => tasks.query(input as TaskFilter) },
      "notification.create": {
        inTransaction: true,
        execute: (input) => notifier.create(input as NotificationCreateInput),
      },
      "run.start": { inTransaction: true, execute: (input) => start(input as RunStartCall) },
      wait: {
        inTransaction: false,
        execute: (input, step) =>
          waitFrom(step.startedAt, (input as { readonly seconds: number }).seconds),
      },
    };

    /**
     * Prepares a step's input: renders the step's params from the run's
     * inputs and the outputs of the steps that have finished, and decodes the
     * result with the action's input schema. Returns the input encoded again
     * with that schema, which is what the step record stores, or the failure
     * the step and its run end with:
     *
     * - `expression_error` when a template cannot be rendered;
     * - `not_found` when the action is not in the catalog;
     * - `validation` when the rendered params do not match the action's
     *   input, or when the action acts through a Connection and the
     *   `connection` param did not render to a Connection id.
     *
     * The action is looked up in the full catalog, so the action of a plugin
     * that is disabled, or that failed to start, is still found: a run that
     * has started finishes its frozen plan.
     *
     * For an action that acts through a Connection, the `connection` param is
     * left out of the decode and stored beside the encoded input. Whether it
     * names a usable Connection is checked by `executeStep`, just before the
     * action runs, because the Connection can change until then.
     */
    const prepareInput = (
      run: Run,
      step: ActionStep,
    ): Effect.Effect<Result.Result<Schema.Json, InputFailure>> =>
      Effect.gen(function* () {
        const rendered = yield* Effect.result(
          renderTemplates(step.params ?? {}, buildRunContext(run)),
        );
        if (Result.isFailure(rendered)) {
          return Result.fail({
            error: { code: "expression_error", message: rendered.failure.message },
            failureReason: "expression-error",
          });
        }
        const found = yield* host.findWorkflowAction(step.action);
        if (Option.isNone(found)) {
          return Result.fail({
            error: buildActionUnavailableError(step.action),
            failureReason: "step-failed",
          });
        }
        const action = found.value;
        const schema = action.input as Schema.Codec<unknown, Schema.Json>;
        // Rendering keeps the shape of the params, which are a record.
        const params = rendered.success as Readonly<Record<string, unknown>>;
        const { connection, actionParams } =
          action.connection === undefined
            ? { connection: undefined, actionParams: params }
            : separateConnectionParam(params);
        let connectionId: string | undefined;
        if (action.connection !== undefined) {
          // Validation allows the param only as a Connection id or as a
          // template that is exactly one Connection input, and a run's inputs
          // are checked when it starts. This is the same rule, applied to the
          // rendered value.
          if (!isId(connection)) {
            return Result.fail({
              error: {
                code: "validation",
                message: `The param ${CONNECTION_PARAM} must render to the id of a Connection of type ${action.connection.type}, but it rendered to ${JSON.stringify(connection)}.`,
              },
              failureReason: "step-failed",
            });
          }
          connectionId = connection;
        }
        const decoded = Schema.decodeUnknownResult(schema)(actionParams, {
          errors: "all",
          onExcessProperty: "error",
        });
        if (Result.isFailure(decoded)) {
          return Result.fail({
            error: {
              code: "validation",
              message: `The rendered params do not match the action's input: ${listDecodeIssues(decoded.failure).map(formatIssue).join("; ")}`,
            },
            failureReason: "step-failed",
          });
        }
        const encoded = Schema.encodeSync(schema)(decoded.success);
        // The input schema is a struct, so the encoded input is an object.
        return Result.succeed(
          connectionId === undefined
            ? encoded
            : { [CONNECTION_PARAM]: connectionId, ...(encoded as Record<string, Schema.Json>) },
        );
      });

    /**
     * Returns the Connection a step acts through, with its credentials read
     * just now, refreshed first if its access token has expired. Returns
     * instead the step error to end the step with:
     *
     * - `not_found` when no Connection has the id `connectionId`;
     * - `validation` when the Connection is of another type than `action`
     *   acts through;
     * - `connection_unavailable` when the Connection is disabled, or its
     *   credentials could not be read.
     *
     * A Connection that needs reauth, or that reported an error, is still
     * used: its credentials may work again, and the action fails with the
     * provider's own error when they do not.
     *
     * Fails only with a database error. Holds no transaction: a refresh
     * calls the provider over the network.
     */
    const readStepConnection = (
      action: RegisteredWorkflowAction & { readonly connection: { readonly type: string } },
      connectionId: string,
    ): Effect.Effect<
      Result.Result<NonNullable<ActionContext["connection"]>, EngineStepError>,
      SqlError
    > =>
      Effect.gen(function* () {
        const wanted = action.connection.type;
        const found = isId(connectionId) ? yield* connections.one(connectionId) : Option.none();
        if (Option.isNone(found)) {
          return Result.fail<EngineStepError>({
            code: "not_found",
            message: `No Connection has the id ${connectionId}. Name a Connection of type ${wanted} in the step's ${CONNECTION_PARAM} param.`,
          });
        }
        const row = found.value;
        if (row.type !== wanted) {
          return Result.fail<EngineStepError>({
            code: "validation",
            message: `The Connection ${connectionId} is of type ${row.type}, but the action ${action.id} acts through a Connection of type ${wanted}. Name a Connection of type ${wanted} in the step's ${CONNECTION_PARAM} param.`,
          });
        }
        if (row.status === "disabled") {
          return Result.fail<EngineStepError>({
            code: "connection_unavailable",
            message: `The Connection ${connectionId} is disabled. Enable it, or name another Connection of type ${wanted}.`,
          });
        }
        const credentials = yield* Effect.result(
          connectionTypes.runtimeFor(action.owner).credentials(connectionId),
        );
        if (Result.isFailure(credentials)) {
          return Result.fail<EngineStepError>({
            code: "connection_unavailable",
            message: `The credentials of the Connection ${connectionId} could not be read: ${credentials.failure.message}. If the Connection needs to sign in again, reconnect it under Connections.`,
          });
        }
        return Result.succeed({
          id: connectionId,
          credentials: credentials.success,
          config: row.config,
        });
      });

    /**
     * Executes one running step record of a run with the input stored on it,
     * and records how the record ended. A failure of the step fails the run. This effect itself fails only with
     * a database error, which is the controller's failure rather than the
     * step's. Does nothing more once the step record has ended some other
     * way, for example because the run was cancelled.
     *
     * A built-in action's effect and the end of its step record commit in one
     * transaction, except for `wait`. A plugin's action reaches outside the
     * controller, so it is called after its record's `running` commits and
     * outside any transaction, and its record ends in a transaction of its own.
     *
     * As in `prepareInput`, the action is looked up in the full catalog. A
     * plugin disabled while the step waits, for example on a token refresh,
     * does not stop the step: the run finishes its frozen plan.
     */
    const executeStep = (
      run: Run,
      attempt: Required<StepRecordKey>,
      input: Schema.Json,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const step = findActionStep(run, attempt.stepId);
        const { startedAt } = attempt;
        const found = yield* host.findWorkflowAction(step.action);
        if (Option.isNone(found)) {
          return yield* failRun(
            run.id,
            attempt,
            buildActionUnavailableError(step.action),
            "step-failed",
          );
        }
        const catalogEntry = found.value;
        // `prepareInput` stored the Connection's id beside the action's own
        // input, which is an object.
        const { connection: connectionId, actionParams } =
          catalogEntry.connection === undefined
            ? { connection: undefined, actionParams: input }
            : separateConnectionParam(input as Readonly<Record<string, unknown>>);
        // The stored input was encoded with this schema, so it decodes; a
        // failure means the catalog entry changed since, and the step fails
        // the way a step with params the action does not take would.
        const decoded = Schema.decodeUnknownResult(catalogEntry.input as Schema.Codec<unknown>)(
          actionParams,
          { errors: "all", onExcessProperty: "error" },
        );
        if (Result.isFailure(decoded)) {
          return yield* failRun(
            run.id,
            attempt,
            {
              code: "validation",
              message: `The step's input does not match the action's input: ${listDecodeIssues(decoded.failure).map(formatIssue).join("; ")}`,
            },
            "step-failed",
          );
        }
        const actor = buildRunActor(run, attempt.stepId);
        const writeCompletion = (output: unknown) =>
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
        const builtIn = isBuiltInControllerActionId(step.action)
          ? builtInActions[step.action]
          : undefined;
        const pluginExecute = catalogEntry.execute;
        let execute: Effect.Effect<void, unknown>;
        if (builtIn !== undefined) {
          const called = Effect.provideService(
            builtIn.execute(decoded.success, { startedAt }),
            CurrentActor,
            actor,
          );
          execute = builtIn.inTransaction
            ? withTransaction(sql, Effect.flatMap(called, writeCompletion))
            : Effect.flatMap(called, (output) => withTransaction(sql, writeCompletion(output)));
        } else if (pluginExecute !== undefined) {
          const { connection: declared } = catalogEntry;
          let connection: ActionContext["connection"];
          if (declared !== undefined) {
            // The stored input names no Connection only when the action
            // started to declare one after the input was stored.
            const resolved =
              typeof connectionId === "string"
                ? yield* readStepConnection({ ...catalogEntry, connection: declared }, connectionId)
                : Result.fail<EngineStepError>({
                    code: "validation",
                    message: `The step's input names no Connection, but the action ${catalogEntry.id} acts through a Connection of type ${declared.type}.`,
                  });
            if (Result.isFailure(resolved)) {
              return yield* failRun(run.id, attempt, resolved.failure, "step-failed");
            }
            connection = resolved.success;
          }
          execute = Effect.flatMap(
            executePluginAction(catalogEntry, pluginExecute, decoded.success, {
              run: { runId: run.id, stepId: attempt.stepId },
              ...(connection === undefined ? {} : { connection }),
            }),
            (output) => withTransaction(sql, writeCompletion(output)),
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

    return { prepareInput, executeStep };
  });
