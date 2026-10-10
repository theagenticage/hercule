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
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
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
  MAX_SIGNAL_OUTCOME_LENGTH,
  nameAnswerRecord,
  type AnswerOperationHandlers,
  type BoundAction,
  type BoundOperation,
  type Issue,
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
import { executePluginAction, PluginHost, type RegisteredWorkflowAction } from "../../plugins";
import { RunService } from "../../runs";
import { TaskService } from "../../tasks";
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
  const host = yield* PluginHost;
  const connections = yield* connectionRepository;
  const connectionTypes = yield* ConnectionTypes;

  // Each runs in the caller's transaction and sends nothing to a runner until
  // it commits: `queueInput` stores the input and delivers it afterwards, and
  // `respondToApprovalRequest` sends its frame afterwards.
  const handlers: AnswerOperationHandlers<
    AnswerPlace,
    Effect.Effect<unknown, BoundOperationError>
  > = {
    "task.create": (input) => tasks.create(input),
    "task.update": ({ taskId, ...changes }) => tasks.update({ id: taskId, ...changes }),
    "run.start": (input) => runs.start(input),
    "session.input": ({ sessionId, ...input }) => live.queueInput({ id: sessionId, ...input }),
    "session.respondToApprovalRequest": ({ sessionId, ...decided }) =>
      live.respondToApprovalRequest({ id: sessionId, ...decided }),
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
      const decoded = yield* Effect.result(
        Schema.decodeUnknownEffect(action.input as Schema.Codec<unknown>, { errors: "all" })(
          operation.input,
        ),
      );
      // The text of a typed reply comes only at the click, so a missing or
      // empty field is not a problem yet.
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

    run: (operation) => Effect.asVoid(dispatchAnswerOperation(handlers, operation)),

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
 * - a line longer than `MAX_SIGNAL_OUTCOME_LENGTH` is cut to that length and
 *   ends in "…", so the reader sees it was cut.
 */
const writeOutcome = (action: RegisteredWorkflowAction, input: unknown): string | undefined => {
  let line: string | undefined;
  try {
    line = action.outcome?.(input);
  } catch {
    return undefined;
  }
  return line === undefined || line.length <= MAX_SIGNAL_OUTCOME_LENGTH
    ? line
    : `${line.slice(0, MAX_SIGNAL_OUTCOME_LENGTH - 1)}…`;
};

/**
 * The bound operations, run with the task and run services, `Live` and the
 * plugin host.
 */
export const BoundOperationsLayer: Layer.Layer<
  BoundOperations,
  never,
  SqlClient.SqlClient | TaskService | RunService | Live | PluginHost | ConnectionTypes
> = Layer.effect(BoundOperations)(make);
