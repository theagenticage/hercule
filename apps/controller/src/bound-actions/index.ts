/**
 * The port through which a record with Bound Actions, a decision
 * Notification or a Signal, checks, runs and describes the operation an
 * answer carries, such as `task.update` or a plugin's `github/pr.merge`.
 *
 * The operations belong to the tasks, runs and sessions domains and to the
 * plugins, and those domains raise notifications, so they depend on the
 * notifications domain. Running or describing their operations from there
 * would make the domain graph a cycle. Instead, this domain declares what a
 * record with Bound Actions needs as one service, and the controller daemon
 * implements it with those domains' services and rows. ADR 0033 owns the
 * rules for breaking a cycle between domains.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  isQualifiedId,
  type AnswerOperation,
  type BoundAction,
  type BoundOperation,
  type CapExceeded,
  type DescribeLine,
  type Forbidden,
  type InvalidState,
  type NotFound,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import type { AnswerPlace } from "@hercule/plugin-host";
import type { SettingError } from "../settings";

/**
 * Every error a bound operation can fail with. `notification.act` and
 * `signal.act` return it unchanged. The API errors reach the caller as they
 * are, so the contract lists each of them on both endpoints. The others (a
 * setting, schema or database error) reach the caller as an internal error.
 */
export type BoundOperationError =
  | Unauthenticated
  | Forbidden
  | Validation
  | NotFound
  | InvalidState
  | CapExceeded
  | SettingError
  | Schema.SchemaError
  | SqlError;

/**
 * A plugin's workflow action bound as an answer, after the check: its
 * qualified id, the Connection it acts through when it declares one, and its
 * input as the answer stores it, before decoding.
 */
export interface PluginAnswerOperation {
  readonly op: string;
  readonly connectionId?: string;
  readonly input: unknown;
}

/**
 * An answer's operation after the check: a contract operation with its
 * decoded input, or a plugin's action.
 */
export type CheckedOperation<Place extends AnswerPlace = AnswerPlace> =
  AnswerOperation<Place> | PluginAnswerOperation;

/**
 * Checks whether a checked operation is a plugin's action. A plugin action's
 * id is qualified, `<pluginId>/<word>`, and no contract operation's id is.
 */
export const isPluginAnswerOperation = (
  operation: CheckedOperation,
): operation is PluginAnswerOperation => isQualifiedId(operation.op);

export class BoundOperations extends Context.Service<
  BoundOperations,
  {
    /**
     * Checks that an answer's operation may run in `place`, and returns it
     * checked. `path` is the path of the whole answer, such as
     * `["actions", "0"]`: a problem with the operation is reported under
     * `[...path, "operation"]`, and a problem with the typed reply under
     * `[...path, "field"]`. Fails with `Validation` when:
     *
     * - a contract operation does not list `place` in its `usableIn`, or its
     *   input does not fit its schema;
     * - a plugin action is not an action of an active plugin, does not list
     *   `place`, or its input does not fit its schema;
     * - `connectionId` is given to an action that declares no Connection, or
     *   left out of one that does;
     * - the named Connection does not exist, is of another type, or is
     *   disabled.
     *
     * `field` is the typed reply of the answer, when it has one. Its text
     * comes only at the click, so the input must leave the field out, and a
     * problem with the field's value is not counted. The field must be a
     * top-level text field of a plugin action's input; a contract operation
     * takes no typed reply.
     */
    readonly check: <Place extends AnswerPlace>(
      place: Place,
      operation: BoundOperation,
      field: BoundAction["field"],
      path: ReadonlyArray<string>,
    ) => Effect.Effect<CheckedOperation<Place>, Validation | SqlError>;

    /**
     * Runs one contract operation as the current actor, in the caller's
     * transaction. Fails with the operation's own error.
     *
     * Nothing it does outside the database happens before the transaction
     * commits: a frame to a runner is sent after the commit, and not at all
     * if the transaction rolls back. So the caller can resolve the record in
     * the same transaction, and both commit or neither does.
     */
    readonly run: (operation: AnswerOperation) => Effect.Effect<void, BoundOperationError>;

    /**
     * Runs one checked plugin action with its Connection's credentials, and
     * returns the line the action writes about its success (its `outcome`),
     * or `undefined` when it writes none.
     *
     * The action reaches outside the controller, so the caller runs this
     * outside any transaction (ADR 0004). Fails with:
     *
     * - `InvalidState` when the action fails, with the action's own message,
     *   or when the Connection's credentials cannot be read;
     * - `NotFound` when the action or the Connection is gone.
     */
    readonly runPluginAction: (
      operation: PluginAnswerOperation,
    ) => Effect.Effect<string | undefined, BoundOperationError>;

    /**
     * Returns the describe lines of a record's checked operations, in the
     * same order, with the current names of the entities their inputs name.
     * An entity that no longer exists is named by its id. The answers of one
     * record usually name the same task or session, so each entity is read
     * once for the whole list. Reads only; it never fails for a missing
     * entity.
     */
    readonly describe: (
      operations: ReadonlyArray<CheckedOperation>,
    ) => Effect.Effect<ReadonlyArray<DescribeLine>, SqlError>;
  }
>()("hercule/controller/bound-actions/BoundOperations") {}
