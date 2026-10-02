/**
 * The notification operations: `notification.query`, `read`, `create`,
 * `withdraw` and `act`.
 *
 * Every caller with the grant reads every notification. The user creates
 * none, because a notification is a message to the user. Creating one, and
 * every other write a producer makes, goes through the `Notifier`, which the
 * domains below this service use too.
 *
 * An open decision is returned to the user with each answer's describe line,
 * written from the current names by the `BindableOperations` port. Taking an
 * answer runs its operation through the same port, as the user, in the
 * transaction that resolves the decision.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  createDecodeValidationError,
  createForbiddenError,
  createInvalidStateError,
  createNotFoundError,
  decodeBindableOperation,
  DEFAULT_PAGE_LIMIT,
  NOTIFICATION_SORT_FIELDS,
  NotificationFilter,
  NotificationWithdrawInput,
  type BindableOperation,
  type BoundAction,
  type BoundOperation,
  type DescribeLine,
  type Forbidden,
  type Id,
  type InvalidState,
  type NotFound,
  type Notification,
  type NotificationAction,
  type NotificationActInput,
  type NotificationProducer,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import {
  buildSessionStamp,
  currentStamp,
  requireGrant,
  requireUserActor,
  type Actor,
  type SessionActor,
} from "../actor";
import {
  buildPageInputFields,
  nowIso,
  refuseCursor,
  resolveSortDirection,
  withTransaction,
} from "../db";
import { AuditLog } from "../events";
import { BindableOperations, type BindableOperationError } from "./bindable-operations";
import { Notifier } from "./notifier";
import { notificationRepository } from "./repository";

/** The input of `notification.query`: the filter, plus the page size, cursor and sort. */
const QueryInput = Schema.Struct({
  ...NotificationFilter.fields,
  ...buildPageInputFields(NOTIFICATION_SORT_FIELDS),
});

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

/** The input of `notification.withdraw`: the notification's id and the reason. */
export interface WithdrawInput extends NotificationWithdrawInput {
  readonly id: Id;
}

/** The input of `notification.act`: the notification's id and the answer to take. */
export interface ActInput extends NotificationActInput {
  readonly id: Id;
}

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeWithdraw = Schema.decodeUnknownEffect(NotificationWithdrawInput);

/** One page of notifications, in the contract's shape. */
export interface NotificationPage {
  readonly items: ReadonlyArray<Notification>;
  readonly nextCursor?: string;
}

const NO_SUCH_NOTIFICATION = "no such notification";

/** The refusal for a run that calls `notification.withdraw`. */
const RUN_CANNOT_WITHDRAW =
  "a run cannot withdraw a notification: it is the run's message to the user, and the run has ended";

/** The refusal for a caller who withdraws a notification someone else produced. */
const NOT_THE_PRODUCER = "only the producer of a notification may withdraw it";

/** The describe line of an answer that runs nothing. */
const NO_OPERATION_DESCRIBE_LINE: DescribeLine = [{ kind: "text", text: "Does nothing" }];

/**
 * The refusal for a caller who is not the user taking an answer. A session
 * may hold `notification.write`, the grant this operation checks, so the
 * message has to say why the grant does not help.
 */
const ONLY_THE_USER =
  "only the user may take an answer: it runs its operation as the user, so a session or a workflow step may not take one; ask the user instead";

/** The refusal for an answer to a decision that is no longer open, or never was. */
const ALREADY_RESOLVED =
  "the notification is already resolved, so its answers can no longer be taken";

/** Checks whether a caller is the session that produced a notification. */
const isProducer = (actor: Actor, producer: NotificationProducer): actor is SessionActor =>
  actor._tag === "session" && producer.type === "session" && producer.sessionId === actor.sessionId;

/**
 * An answer's operation after the check at read time: decoded, or refused,
 * with a describe line that shows the user why the answer cannot be taken.
 */
type CheckedOperation =
  | { readonly _tag: "decoded"; readonly operation: BindableOperation }
  | { readonly _tag: "refused"; readonly describeLine: DescribeLine };

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const notifications = yield* notificationRepository;
  const audit = yield* AuditLog;
  const notifier = yield* Notifier;
  const operations = yield* BindableOperations;

  /**
   * Checks an answer's stored operation again before it is described. A
   * stored answer whose operation no longer passes the check, because the
   * list of operations an answer may run or a schema changed since it was
   * created, cannot be taken, and its describe line shows the user why.
   */
  const checkStoredOperation = (operation: BoundOperation): Effect.Effect<CheckedOperation> =>
    decodeBindableOperation(operation, []).pipe(
      Effect.match({
        onFailure: (refused): CheckedOperation => ({
          _tag: "refused",
          describeLine: [
            {
              kind: "text",
              text: `Cannot be taken: ${refused.error.details.issues[0]?.message ?? refused.error.message}`,
            },
          ],
        }),
        onSuccess: (decoded): CheckedOperation => ({ _tag: "decoded", operation: decoded }),
      }),
    );

  /**
   * Returns a notification with the describe line on each answer when it is
   * an open decision. The operations of all its answers are described in one
   * call to the describer. A resolved decision's answers can no longer be
   * taken, so it is returned as stored.
   */
  const addDescribeLines = (notification: Notification): Effect.Effect<Notification, SqlError> =>
    Effect.gen(function* () {
      if (notification.status !== "open") return notification;
      const checked = yield* Effect.forEach(notification.actions, (action) =>
        action.operation === null
          ? Effect.succeed<CheckedOperation>({
              _tag: "refused",
              describeLine: NO_OPERATION_DESCRIBE_LINE,
            })
          : checkStoredOperation(action.operation),
      );
      const lines = yield* operations.describe(
        checked.flatMap((entry) => (entry._tag === "decoded" ? [entry.operation] : [])),
      );
      let nextLine = 0;
      const actions = notification.actions.map((action, index): NotificationAction => {
        const entry = checked[index]!;
        const describeLine = entry._tag === "refused" ? entry.describeLine : lines[nextLine++]!;
        return { ...action, describeLine };
      });
      return { ...notification, actions };
    });

  const readOrFail = (id: string): Effect.Effect<Notification, NotFound | SqlError> =>
    Effect.flatMap(
      notifications.read(id),
      Option.match({
        onNone: () => Effect.fail(createNotFoundError(NO_SUCH_NOTIFICATION)),
        onSome: Effect.succeed,
      }),
    );

  /**
   * Resolves the decision as decided with the answer the user took. Fails
   * with `InvalidState` if it was resolved any other way in the meantime.
   *
   * An operation may already have resolved the decision itself, with this
   * same answer: `session.respondToApprovalRequest` resolves the approval decision about its
   * request with the answer that carries it. That counts as decided too.
   */
  const decideOrFail = (
    notification: Notification,
    action: BoundAction,
  ): Effect.Effect<void, InvalidState | NotFound | SqlError> =>
    Effect.gen(function* () {
      if (yield* notifier.decide(notification, action)) return;
      const { resolution } = yield* readOrFail(notification.id);
      if (resolution?.kind === "decided" && resolution.actionId === action.id) return;
      return yield* Effect.fail(createInvalidStateError(ALREADY_RESOLVED));
    });

  return {
    /**
     * Returns one page of the notifications that match a filter, newest
     * first by default. The describe lines are added only for the user, the
     * only caller who can take an answer.
     */
    query: (
      input: QueryInput,
    ): Effect.Effect<NotificationPage, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        const caller = yield* requireGrant("notification.query");
        const decoded = yield* Effect.mapError(decodeQuery(input), createDecodeValidationError);
        const { limit, cursor, sort, ...filter } = decoded;
        const listing = yield* refuseCursor(
          notifications.list(filter, {
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: resolveSortDirection(sort, "desc"),
          }),
        );
        return {
          items:
            caller._tag === "user"
              ? yield* Effect.forEach(listing.items, addDescribeLines)
              : listing.items,
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
      }),

    /**
     * Returns one notification by id. For the user, each answer of an open
     * decision carries its describe line. Fails with `NotFound` if it does
     * not exist.
     */
    read: (
      id: Id,
    ): Effect.Effect<Notification, Unauthenticated | Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        const caller = yield* requireGrant("notification.read");
        const notification = yield* readOrFail(id);
        return caller._tag === "user" ? yield* addDescribeLines(notification) : notification;
      }),

    /** Creates a notification as the calling session or run step; see `Notifier.create`. */
    create: notifier.create,

    /**
     * Withdraws an open decision because its question stopped existing, and
     * returns it resolved. Only the session that produced a notification may
     * withdraw it.
     *
     * Fails with:
     *
     * - `Validation` if the reason is empty or longer than one line;
     * - `Forbidden` if the caller is a run, or did not produce it;
     * - `NotFound` if the notification does not exist;
     * - `InvalidState` if it is already resolved, which includes every
     *   informational notification.
     */
    withdraw: (
      input: WithdrawInput,
    ): Effect.Effect<
      Notification,
      Unauthenticated | Forbidden | Validation | NotFound | InvalidState | SqlError
    > =>
      Effect.gen(function* () {
        const caller = yield* requireGrant("notification.withdraw");
        if (caller._tag === "run") {
          return yield* Effect.fail(
            createForbiddenError("notification.write", RUN_CANNOT_WITHDRAW),
          );
        }
        const { reason } = yield* Effect.mapError(
          decodeWithdraw({ reason: input.reason }),
          createDecodeValidationError,
        );
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const notification = yield* readOrFail(input.id);
            if (!isProducer(caller, notification.producer)) {
              return yield* Effect.fail(
                createForbiddenError("notification.write", NOT_THE_PRODUCER),
              );
            }
            if (notification.actions.length === 0) {
              return yield* Effect.fail(
                createInvalidStateError(
                  "an informational notification has no question to withdraw",
                ),
              );
            }
            const actor = yield* currentStamp;
            const resolution = {
              kind: "withdrawn" as const,
              actor,
              origin: buildSessionStamp(caller.sessionId),
              reason,
              at: yield* nowIso,
            };
            // The status is checked by the write itself, so a resolution that
            // lands between the read above and this write still wins.
            if (!(yield* notifications.resolve(input.id, resolution))) {
              return yield* Effect.fail(
                createInvalidStateError("the notification is already resolved"),
              );
            }
            yield* audit.append({
              kind: "notification.withdrawn",
              actor,
              record: { topic: "notification", id: input.id },
              payload: { notificationId: input.id, reason },
              at: resolution.at,
            });
            return { ...notification, status: "resolved" as const, resolution };
          }),
        );
      }),

    /**
     * Takes one answer of an open decision: runs its operation as the user,
     * resolves the decision as decided with that answer, and returns the
     * notification as it reads afterwards. An answer that runs nothing only
     * resolves the decision.
     *
     * The rules:
     *
     * - Only the user may take an answer. The producer's grants are never
     *   checked, because the user's click is the authorisation, so an agent
     *   that could click would run any bindable operation as the user.
     * - The answer's operation is checked again before it runs, because the
     *   list of operations an answer may run, or a schema, may have changed
     *   since the notification was created.
     * - The read, the operation and the resolution share one transaction, so
     *   the operation's writes and the resolution commit together or not at
     *   all. The operation sends nothing to a runner before the commit.
     *   Transactions run one at a time, so a second answer to the same
     *   decision waits for the first. It finds the decision resolved if the
     *   first succeeded, and runs if the first failed.
     *
     * Fails with:
     *
     * - `Forbidden` for any caller but the user, even one that holds the
     *   grant;
     * - `NotFound` if the notification does not exist or has no such answer;
     * - `InvalidState` if the decision is already resolved, which includes
     *   every informational notification;
     * - `Validation` if the answer's operation is no longer one an answer may
     *   run, or its input no longer fits; the decision stays open;
     * - the operation's own error when it fails; the decision stays open.
     */
    act: (input: ActInput): Effect.Effect<Notification, BindableOperationError> =>
      Effect.gen(function* () {
        yield* requireUserActor("notification.act", ONLY_THE_USER);
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const notification = yield* readOrFail(input.id);
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
            if (action.operation !== null) {
              yield* operations.run(
                yield* decodeBindableOperation(action.operation, ["operation"]),
              );
            }
            yield* decideOrFail(notification, action);
          }),
        );
        return yield* readOrFail(input.id);
      }),
  };
});

/** The notification service. */
export class NotificationService extends Context.Service<
  NotificationService,
  Effect.Success<typeof make>
>()("hercule/controller/notifications/NotificationService") {}

export const NotificationServiceLayer: Layer.Layer<
  NotificationService,
  never,
  SqlClient.SqlClient | AuditLog | Notifier | BindableOperations
> = Layer.effect(NotificationService)(make);
