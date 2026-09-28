/**
 * `notification.act`: the user takes one answer of an open decision. The
 * answer's operation runs as the user, and the decision is resolved as
 * decided with that answer.
 *
 * This operation is a controller daemon use case rather than a method of the
 * notifications domain behind a port, the usual way out of a cycle
 * (ADR 0033), because a port cannot be wired here:
 *
 * - it runs operations of the task service, the run service and the `Live`
 *   use case, and all three are built on top of `NotificationService`. A port
 *   that `NotificationService` needs, implemented with those services, would
 *   make the layers a cycle: none could be built before the others;
 * - `session.input` and `session.respond` reach a runner through `Live`, and
 *   talking to a runner is controller daemon work.
 *
 * The rules:
 *
 * - Only the user may take an answer. The producer's grants are never
 *   checked, because the user's click is the authorisation, so an agent that
 *   could click would run any bindable operation as the user.
 * - The answer's operation is checked again before it runs, because the list
 *   of operations an answer may run, or a schema, may have changed since the
 *   notification was created.
 * - When the operation fails, its own error is returned and the decision
 *   stays open, so the user can try again or take another answer.
 * - `task.update`, `run.start` and `session.input` run in the same
 *   transaction as the resolution, so both commit or neither does.
 *   `session.input` only stores the input there; it is sent to the runner
 *   after the commit, so a decision that cannot be resolved sends nothing.
 * - `session.respond` sends its frame before it returns, and a sent frame
 *   cannot be rolled back, so it runs on its own. It resolves the decision
 *   itself, in the transaction that records the answer and before the frame
 *   is sent, so the resolution after it finds the decision resolved already.
 *
 * Spec 10 §7.4 owns the rules.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  createInvalidStateError,
  createNotFoundError,
  decodeBindableOperation,
  type BindableOperation,
  type BindableOperationId,
  type BindableOperationInput,
  type CapExceeded,
  type Forbidden,
  type Id,
  type InvalidState,
  type NotFound,
  type Notification,
  type NotificationActInput,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { requireUserActor } from "../../actor";
import { withTransaction } from "../../db";
import { NotificationService, notificationRepository } from "../../notifications";
import { RunService } from "../../runs";
import type { SettingError } from "../../settings";
import { TaskService } from "../../tasks";
import { Live } from "../sessions";

/** The input of `notification.act`: the notification's id and the answer to take. */
interface ActInput extends NotificationActInput {
  readonly id: Id;
}

/**
 * Every error an answer's operation can fail with. `notification.act`
 * returns it unchanged, so the contract lists these errors on the endpoint.
 */
type OperationError =
  | Unauthenticated
  | Forbidden
  | Validation
  | NotFound
  | InvalidState
  | CapExceeded
  | SettingError
  | Schema.SchemaError
  | SqlError;

/** How one bindable operation runs when an answer is taken. */
interface OperationExecutor<Op extends BindableOperationId> {
  /**
   * Whether the operation runs in the same transaction as the resolution:
   * true when everything it does before it returns can be rolled back. False
   * for an operation that sends a frame to a runner before it returns, which
   * no rollback can undo.
   */
  readonly inTransaction: boolean;
  readonly execute: (input: BindableOperationInput<Op>) => Effect.Effect<unknown, OperationError>;
}

/**
 * The refusal for a caller who is not the user. A session may hold
 * `notification.write`, the grant this operation checks, so the message has
 * to say why the grant does not help.
 */
const ONLY_THE_USER =
  "only the user may take an answer: it runs its operation as the user, so a session or a workflow step may not take one; ask the user instead";

/** The refusal for an answer to a decision that is no longer open, or never was. */
const ALREADY_RESOLVED =
  "the notification is already resolved, so its answers can no longer be taken";

/**
 * The refusal for an answer to a decision while another answer to it is still
 * being taken, such as a second click during a slow operation.
 */
const BEING_TAKEN =
  "an answer to this notification is already being taken; read the notification again once that finishes";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const notifications = yield* NotificationService;
  const storedNotifications = yield* notificationRepository;
  const tasks = yield* TaskService;
  const runs = yield* RunService;
  const live = yield* Live;
  // A second click on the same notification, while the first one's operation
  // still runs, would otherwise read it as open and run an operation a second
  // time.
  const notificationIdsBeingActedOn = yield* Ref.make<ReadonlySet<string>>(new Set());

  const executors = {
    "task.update": {
      inTransaction: true,
      execute: ({ taskId, ...changes }) => tasks.update({ id: taskId, ...changes }),
    },
    "run.start": { inTransaction: true, execute: (input) => runs.start(input) },
    "session.input": {
      inTransaction: true,
      execute: ({ sessionId, ...input }) => live.queueInput({ id: sessionId, ...input }),
    },
    "session.respond": {
      inTransaction: false,
      execute: ({ sessionId, ...answer }) => live.respond({ id: sessionId, ...answer }),
    },
  } satisfies { readonly [Op in BindableOperationId]: OperationExecutor<Op> };

  /**
   * Runs `effect` while holding the notification `id`, so no other answer to
   * it is taken at the same time. Fails with `InvalidState` when another
   * answer is being taken already. The hold is released however `effect`
   * ends.
   */
  const withNotificationHeld = <A, E, R>(
    id: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | InvalidState, R> =>
    Effect.acquireUseRelease(
      Ref.modify(notificationIdsBeingActedOn, (ids): [boolean, ReadonlySet<string>] =>
        ids.has(id) ? [false, ids] : [true, new Set([...ids, id])],
      ),
      (held): Effect.Effect<A, E | InvalidState, R> =>
        held ? effect : Effect.fail(createInvalidStateError(BEING_TAKEN)),
      (held) =>
        held
          ? Ref.update(
              notificationIdsBeingActedOn,
              (ids) => new Set([...ids].filter((heldId) => heldId !== id)),
            )
          : Effect.void,
    );

  /** Resolves the decision with the answer, or fails with `InvalidState` if it is no longer open. */
  const decideOrFail = (
    notificationId: Id,
    actionId: string,
  ): Effect.Effect<void, InvalidState | SqlError> =>
    Effect.flatMap(notifications.decide(notificationId, actionId), (decided) =>
      decided ? Effect.void : Effect.fail(createInvalidStateError(ALREADY_RESOLVED)),
    );

  /**
   * Runs an answer's operation and resolves the decision with the answer.
   * Fails with the operation's own error, and the decision stays open.
   */
  const executeAndDecide = (
    notificationId: Id,
    actionId: string,
    operation: BindableOperation,
  ): Effect.Effect<void, OperationError> => {
    // TypeScript cannot relate the entry to the input across the union, so
    // the entry is widened to take any bindable input; the table above is
    // what ties each operation to its own executor.
    const executor = executors[operation.op] as OperationExecutor<BindableOperationId>;
    const execute = executor.execute(operation.input);
    if (executor.inTransaction) {
      // A decision resolved since it was read, such as one withdrawn by its
      // producer, fails the transaction, so the operation rolls back with it.
      // Uninterruptible because the operation's work after the commit, such
      // as handing a new run to its executor, must not be lost to a caller
      // that hangs up.
      return Effect.uninterruptible(
        withTransaction(
          sql,
          Effect.flatMap(execute, () => decideOrFail(notificationId, actionId)),
        ),
      );
    }
    // The operation already reached a runner, so the decision is resolved
    // even if the caller hangs up now. `decide` returns false when the
    // operation resolved the decision itself, as `session.respond` does for
    // the approval it answers; the decision is resolved either way.
    return Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(restore(execute), () =>
        Effect.asVoid(notifications.decide(notificationId, actionId)),
      ),
    );
  };

  return {
    /**
     * Takes one answer of an open decision: runs its operation as the user,
     * resolves the decision as decided with that answer, and returns the
     * notification as it reads afterwards. An answer that runs nothing only
     * resolves the decision.
     *
     * Fails with:
     *
     * - `Forbidden` for any caller but the user, even one that holds the
     *   grant;
     * - `NotFound` if the notification does not exist or has no such answer;
     * - `InvalidState` if the decision is already resolved, which includes
     *   every informational notification, or another answer to it is being
     *   taken right now;
     * - `Validation` if the answer's operation is no longer one an answer may
     *   run, or its input no longer fits; the decision stays open;
     * - the operation's own error when it fails; the decision stays open.
     */
    act: (input: ActInput): Effect.Effect<Notification, OperationError> =>
      Effect.gen(function* () {
        yield* requireUserActor("notification.act", ONLY_THE_USER);
        yield* withNotificationHeld(
          input.id,
          Effect.gen(function* () {
            // The stored record, without describe lines: only its answers
            // are needed, and describing them would read other domains' rows.
            const found = yield* storedNotifications.read(input.id);
            if (Option.isNone(found)) {
              return yield* Effect.fail(createNotFoundError("no such notification"));
            }
            const notification = found.value;
            if (notification.status !== "open") {
              return yield* Effect.fail(createInvalidStateError(ALREADY_RESOLVED));
            }
            const action = notification.actions.find(
              (candidate) => candidate.id === input.actionId,
            );
            if (action === undefined) {
              const offered = notification.actions.map((offer) => offer.id).join(", ");
              return yield* Effect.fail(
                createNotFoundError(
                  `the notification has no answer "${input.actionId}"; its answers are ${offered}`,
                ),
              );
            }
            if (action.operation === null) {
              return yield* decideOrFail(input.id, action.id);
            }
            const operation = yield* decodeBindableOperation(action.operation, ["operation"]);
            yield* executeAndDecide(input.id, action.id, operation);
          }),
        );
        return yield* notifications.read(input.id);
      }),
  };
});

/** `notification.act`, the operation that takes an answer of a decision. */
export class Answering extends Context.Service<Answering, Effect.Success<typeof make>>()(
  "hercule/controller/daemon/Answering",
) {}

export const AnsweringLayer: Layer.Layer<
  Answering,
  never,
  SqlClient.SqlClient | NotificationService | TaskService | RunService | Live
> = Layer.effect(Answering)(make);
