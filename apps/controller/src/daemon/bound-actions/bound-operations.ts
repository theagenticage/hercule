/**
 * The controller daemon's implementation of the `BoundOperations` port: it
 * checks the operation an answer carries, runs it, and writes its describe
 * line.
 *
 * It lives here because the operations belong to domains above the
 * notifications domain and to the plugins, and `session.input` and
 * `session.respondToApprovalRequest` go through `Live`, which talks to
 * runners.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  createDecodeValidationError,
  createInvalidStateError,
  createNotFoundError,
  createValidationError,
  decodeAnswerOperation,
  dispatchAnswerOperation,
  isId,
  isQualifiedId,
  listSchemaIssues,
  nameAnswerRecord,
  type AnswerOperationHandlers,
  type BoundAction,
  type BoundOperation,
  type Issue,
  type RunStarted,
  type Validation,
} from "@hercule/contract";
import type { AnswerPlace } from "@hercule/plugin-host";
import {
  BoundOperations,
  type BoundOperationError,
  type CheckedOperation,
  type PluginAnswerOperation,
} from "../../bound-actions";
import { connectionRepository, ConnectionTypes } from "../../connections";
import type { PermissionProfiles } from "../../permissions";
import { executePluginAction, PluginHost, type RegisteredWorkflowAction } from "../../plugins";
import { RunService } from "../../runs";
import { IgnoreRuleService, SignalHandoffs, truncateOutcome } from "../../signals";
import type { Settings } from "../../settings";
import { TaskService } from "../../tasks";
import { WorkflowService } from "../../workflows";
import { PermissionRequests } from "../permissions";
import { Live } from "../sessions";
import { buildDescribe } from "./describer";

/**
 * Lists the problems with a typed reply's field on a plugin action. The field
 * must be a top-level text field of the action's input, and the bound input
 * must leave it out, because the text the user types fills it.
 */
const listFieldIssues = (
  action: RegisteredWorkflowAction,
  field: NonNullable<BoundAction["field"]>,
  input: unknown,
  path: ReadonlyArray<string>,
): ReadonlyArray<Issue> => {
  const ast = action.input.ast;
  const property = SchemaAST.isObjects(ast)
    ? ast.propertySignatures.find((candidate) => candidate.name === field.name)
    : undefined;
  if (property === undefined || !SchemaAST.isString(property.type)) {
    return [
      {
        path: [...path, "field", "name"],
        message: `The input of ${action.id} has no top-level text field named ${field.name}. A typed reply fills one such field.`,
      },
    ];
  }
  if (typeof input === "object" && input !== null && Object.hasOwn(input, field.name)) {
    return [
      {
        path: [...path, "operation", "input", field.name],
        message: `Leave ${field.name} out of the input: the text the user types fills it.`,
      },
    ];
  }
  return [];
};

const make = Effect.gen(function* () {
  const tasks = yield* TaskService;
  const runs = yield* RunService;
  const live = yield* Live;
  const permissionRequests = yield* PermissionRequests;
  const ignoreRules = yield* IgnoreRuleService;
  const host = yield* PluginHost;
  const connections = yield* connectionRepository;
  const connectionTypes = yield* ConnectionTypes;
  const workflows = yield* WorkflowService;
  const handoffs = yield* SignalHandoffs;

  // Each runs in the caller's transaction and sends nothing to a runner until
  // it commits: `run.start` and `signal.handOff` place the run's first
  // session afterwards, `queueInput` stores the input and delivers it
  // afterwards, and `respondToApprovalRequest` sends its frame afterwards.
  // Each returns the run it started, or `undefined`.
  const handlers: AnswerOperationHandlers<
    AnswerPlace,
    Effect.Effect<RunStarted | undefined, BoundOperationError>
  > = {
    "task.create": (input) => Effect.as(tasks.create(input), undefined),
    "task.update": ({ taskId, ...changes }) =>
      Effect.as(tasks.update({ id: taskId, ...changes }), undefined),
    "run.start": (input) => runs.start(input),
    "signal.handOff": (input) => handoffs.handOff(input),
    "session.input": ({ sessionId, ...input }) =>
      Effect.as(live.queueInput({ id: sessionId, ...input }), undefined),
    "session.respondToApprovalRequest": ({ sessionId, ...decided }) =>
      Effect.as(live.respondToApprovalRequest({ id: sessionId, ...decided }), undefined),
    "permission.decide": (input) => Effect.as(permissionRequests.decide(input), undefined),
    "ignoreRule.create": (input) => Effect.as(ignoreRules.create(input), undefined),
    "trigger.resume": (input) => Effect.as(workflows.resumeTrigger(input), undefined),
  };

  /**
   * Lists the problems with the Connection a plugin action is bound with:
   * `connectionId` is present exactly when the action declares a Connection,
   * and the Connection exists, has the action's type and is enabled.
   */
  const listConnectionIssues = (
    action: RegisteredWorkflowAction,
    connectionId: string | undefined,
    path: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<Issue>, SqlError> =>
    Effect.gen(function* () {
      const at = [...path, "connectionId"];
      if (action.connection === undefined) {
        return connectionId === undefined
          ? []
          : [
              {
                path: at,
                message: `The action ${action.id} acts through no Connection. Leave out connectionId.`,
              },
            ];
      }
      const wanted = action.connection.type;
      if (connectionId === undefined) {
        return [
          {
            path: at,
            message: `The action ${action.id} acts through a Connection of type ${wanted}. Name it in connectionId.`,
          },
        ];
      }
      const found = isId(connectionId) ? yield* connections.one(connectionId) : Option.none();
      if (Option.isNone(found)) {
        return [
          {
            path: at,
            message: `No Connection has the id ${connectionId}. Name a Connection of type ${wanted}.`,
          },
        ];
      }
      if (found.value.type !== wanted) {
        return [
          {
            path: at,
            message: `The Connection ${connectionId} is of type ${found.value.type}, but the action ${action.id} acts through a Connection of type ${wanted}.`,
          },
        ];
      }
      if (found.value.status === "disabled") {
        return [
          {
            path: at,
            message: `The Connection ${connectionId} is disabled. Enable it under Connections, or name another Connection of type ${wanted}.`,
          },
        ];
      }
      return [];
    });

  /** Checks a plugin action bound as an answer; see `BoundOperations.check`. */
  const checkPluginAction = (
    place: AnswerPlace,
    operation: BoundOperation,
    field: BoundAction["field"],
    path: ReadonlyArray<string>,
  ): Effect.Effect<PluginAnswerOperation, Validation | SqlError> =>
    Effect.gen(function* () {
      const operationPath = [...path, "operation"];
      const action = (yield* host.listActiveWorkflowActions()).find(
        (candidate) => candidate.id === operation.op,
      );
      if (action === undefined) {
        return yield* Effect.fail(
          createValidationError([
            {
              path: [...operationPath, "op"],
              message: `${operation.op} is not an action of an active plugin. Enable its plugin, or bind another action.`,
            },
          ]),
        );
      }
      if (!action.usableIn.includes(place)) {
        return yield* Effect.fail(
          createValidationError([
            {
              path: [...operationPath, "op"],
              message: `The action ${action.id} does not list ${place} in its usableIn, so an answer on a ${nameAnswerRecord(place)} cannot run it.`,
            },
          ]),
        );
      }
      const fieldIssues =
        field === undefined ? [] : listFieldIssues(action, field, operation.input, path);
      // The text of a typed reply comes only at the click. The input is
      // checked as it will be then, with some text in the field, so a check
      // that spans fields passes, such as pr.review's "a body is required
      // unless the verdict is approve". Any problem with the field's own
      // value is not counted, because the user has not typed it yet.
      const inputAtClick =
        field === undefined || typeof operation.input !== "object" || operation.input === null
          ? operation.input
          : { ...operation.input, [field.name]: "typed reply" };
      const decoded = yield* Effect.result(
        Schema.decodeUnknownEffect(action.input as Schema.Codec<unknown>, { errors: "all" })(
          inputAtClick,
        ),
      );
      const inputIssues =
        decoded._tag === "Success"
          ? []
          : listSchemaIssues(decoded.failure.issue).filter(
              (issue) => field === undefined || issue.path[0] !== field.name,
            );
      const issues = [
        ...fieldIssues,
        ...inputIssues.map((issue) => ({
          ...issue,
          path: [...operationPath, "input", ...issue.path],
        })),
        ...(yield* listConnectionIssues(action, operation.connectionId, operationPath)),
      ];
      if (issues.length > 0) return yield* Effect.fail(createValidationError(issues));
      return {
        op: action.id,
        ...(operation.connectionId === undefined ? {} : { connectionId: operation.connectionId }),
        input: operation.input,
      };
    });

  return BoundOperations.of({
    check: <Place extends AnswerPlace>(
      place: Place,
      operation: BoundOperation,
      field: BoundAction["field"],
      path: ReadonlyArray<string>,
    ): Effect.Effect<CheckedOperation<Place>, Validation | SqlError> => {
      if (isQualifiedId(operation.op)) return checkPluginAction(place, operation, field, path);
      const op = operation.op;
      const issues: Array<Issue> = [];
      if (operation.connectionId !== undefined) {
        issues.push({
          path: [...path, "operation", "connectionId"],
          message: `${op} is a core operation and acts through no Connection. Leave out connectionId.`,
        });
      }
      if (field !== undefined) {
        issues.push({
          path: [...path, "field"],
          message: `A typed reply fills a text field of a plugin action's input; ${op} is a core operation and takes none. Leave out field.`,
        });
      }
      return issues.length > 0
        ? Effect.fail(createValidationError(issues))
        : decodeAnswerOperation(place, operation, [...path, "operation"]);
    },

    run: (operation) => dispatchAnswerOperation(handlers, operation),

    runPluginAction: (operation) =>
      Effect.gen(function* () {
        const found = yield* host.findWorkflowAction(operation.op);
        const execute = Option.isSome(found) ? found.value.execute : undefined;
        if (Option.isNone(found) || execute === undefined) {
          return yield* Effect.fail(
            createNotFoundError(`the action ${operation.op} is no longer registered`),
          );
        }
        const action = found.value;
        const input = yield* Effect.mapError(
          Schema.decodeUnknownEffect(action.input as Schema.Codec<unknown>)(operation.input),
          createDecodeValidationError,
        );
        const context =
          operation.connectionId === undefined
            ? {}
            : { connection: yield* readConnection(action, operation.connectionId) };
        yield* Effect.mapError(executePluginAction(action, execute, input, context), (failed) =>
          createInvalidStateError(`${action.displayName} failed: ${failed.message}`),
        );
        return writeOutcome(action, operation.input);
      }),

    describe: yield* buildDescribe,
  });

  /**
   * Reads the Connection a plugin action acts through, with its credentials,
   * just before the action runs. Fails with `NotFound` when the Connection is
   * gone, and with `InvalidState` when it is disabled or its credentials
   * cannot be read. Holds no transaction: reading the credentials may
   * refresh a token over the network.
   */
  function readConnection(action: RegisteredWorkflowAction, connectionId: string) {
    return Effect.gen(function* () {
      const found = yield* connections.one(connectionId);
      if (Option.isNone(found)) {
        return yield* Effect.fail(createNotFoundError(`no Connection has the id ${connectionId}`));
      }
      if (found.value.status === "disabled") {
        return yield* Effect.fail(
          createInvalidStateError(
            `the Connection ${found.value.label} is disabled; enable it under Connections and try again`,
          ),
        );
      }
      const credentials = yield* Effect.mapError(
        connectionTypes.runtimeFor(action.owner).credentials(connectionId),
        (failed) =>
          createInvalidStateError(
            `the credentials of the Connection ${found.value.label} could not be read: ${failed.message}. If it needs to sign in again, reconnect it under Connections`,
          ),
      );
      return { id: connectionId, credentials, config: found.value.config };
    });
  }
});

/**
 * Returns the line a plugin action writes about its success, or `undefined`
 * when it declares no `outcome`. The action has already run, so neither a bug
 * in its `outcome` nor a line that is too long may turn the success into an
 * error:
 *
 * - when `outcome` throws, this returns `undefined`, and the caller writes
 *   the line from the answer's label instead;
 * - a line that is too long is cut by `truncateOutcome`.
 */
const writeOutcome = (action: RegisteredWorkflowAction, input: unknown): string | undefined => {
  let line: string | undefined;
  try {
    line = action.outcome?.(input);
  } catch {
    return undefined;
  }
  return line === undefined ? undefined : truncateOutcome(line);
};

/**
 * The bound operations, run with the task, run and workflow services,
 * `Live`, the Permission Request use case and the plugin host. Describing an
 * answer reads the permission profiles, to name the profile a Permission
 * Request's `profile` answer widens, and the settings, for the default spawn
 * bound a `trigger.resume` line names.
 */
export const BoundOperationsLayer: Layer.Layer<
  BoundOperations,
  never,
  | SqlClient.SqlClient
  | TaskService
  | RunService
  | Live
  | PermissionRequests
  | PermissionProfiles
  | IgnoreRuleService
  | SignalHandoffs
  | PluginHost
  | ConnectionTypes
  | WorkflowService
  | Settings
> = Layer.effect(BoundOperations)(make);
