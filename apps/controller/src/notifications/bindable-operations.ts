/**
 * The port through which the notifications domain runs and describes the
 * operation an answer carries, such as `task.update` or `session.input`.
 *
 * The bindable operations belong to the tasks, runs and sessions domains, and
 * those domains raise notifications, so they depend on this one. Running or
 * describing their operations from here would make the domain graph a cycle.
 * Instead, the notifications domain declares what it needs as this service,
 * and the controller daemon implements it with those domains' services and
 * rows. ADR 0033 owns the rules for breaking a cycle between domains.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type {
  BindableOperation,
  CapExceeded,
  DescribeLine,
  Forbidden,
  InvalidState,
  NotFound,
  Unauthenticated,
  Validation,
} from "@hercule/contract";
import type { SettingError } from "../settings";

/**
 * Every error a bindable operation can fail with. `notification.act` returns
 * it unchanged. The API errors reach the caller as they are, so the contract
 * lists each of them on the `notification.act` endpoint. The others (a
 * setting, schema or database error) reach the caller as an internal error.
 */
export type BindableOperationError =
  | Unauthenticated
  | Forbidden
  | Validation
  | NotFound
  | InvalidState
  | CapExceeded
  | SettingError
  | Schema.SchemaError
  | SqlError;

export class BindableOperations extends Context.Service<
  BindableOperations,
  {
    /**
     * Runs one operation as the current actor, in the caller's transaction.
     * Fails with the operation's own error.
     *
     * Nothing it does outside the database happens before the transaction
     * commits: a frame to a runner is sent after the commit, and not at all
     * if the transaction rolls back. So the caller can resolve the decision
     * in the same transaction, and both commit or neither does.
     */
    readonly run: (operation: BindableOperation) => Effect.Effect<void, BindableOperationError>;

    /**
     * Returns the describe lines of the operations of one notification's
     * answers, in the same order, with the current names of the entities
     * their inputs name. An entity that no longer exists is named by its id.
     * The answers of one decision usually name the same task or session, so
     * each entity is read once for the whole list. Reads only; it never
     * fails for a missing entity.
     */
    readonly describe: (
      operations: ReadonlyArray<BindableOperation>,
    ) => Effect.Effect<ReadonlyArray<DescribeLine>, SqlError>;
  }
>()("hercule/controller/notifications/BindableOperations") {}
