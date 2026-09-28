/**
 * The notification operations: `notification.query`, `read`, `create` and
 * `withdraw`, plus two the controller calls for the core's own
 * notifications: `createCoreNotification` and `withdrawDecisionsAbout`.
 *
 * The producer and its mute key are stamped from the caller, never taken from
 * the payload:
 *
 * - a session produces as itself, and its mute key is `assistant:<id>` when
 *   the session speaks for an assistant;
 * - a run's step produces as that run and step, and its mute key is
 *   `workflow:<id>` when the run was started from a stored workflow;
 * - the core produces its own `core.*` kinds through `createCoreNotification`,
 *   and cannot be muted.
 *
 * The user reads notifications but does not create them: a notification is a
 * message to the user.
 *
 * Every write records one audit entry in the same transaction and announces
 * the change on the `notification` live topic. Muting decides only whether a
 * notification is pushed to a delivery sink. No sink exists yet, so the mute
 * key is recorded on the notification and nothing reads it here.
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
  DEFAULT_PAGE_LIMIT,
  MAX_NOTIFICATION_BODY_LENGTH,
  MAX_NOTIFICATION_TITLE_LENGTH,
  NOTIFICATION_SORT_FIELDS,
  NotificationCreateInput,
  NotificationFilter,
  NotificationWithdrawInput,
  type BoundAction,
  type CoreNotificationKind,
  type EventId,
  type Forbidden,
  type Id,
  type InvalidState,
  type MuteKey,
  type NotFound,
  type Notification,
  type NotificationCreateResult,
  type NotificationProducer,
  type NotificationSubject,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import {
  buildSessionStamp,
  currentStamp,
  requireGrant,
  SYSTEM_ACTOR,
  type Actor,
  type RunActor,
  type SessionActor,
} from "../actor";
import { buildPageInputFields, nowIso, refuseCursor, withTransaction } from "../db";
import { AuditLog } from "../events";
import { notificationRepository, type NewNotification } from "./repository";

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

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeCreate = Schema.decodeUnknownEffect(NotificationCreateInput);
const decodeWithdraw = Schema.decodeUnknownEffect(NotificationWithdrawInput);

/** One page of notifications, in the contract's shape. */
export interface NotificationPage {
  readonly items: ReadonlyArray<Notification>;
  readonly nextCursor?: string;
}

/** A notification the core raises about itself. */
export interface CoreNotification {
  readonly kind: CoreNotificationKind;
  readonly title: string;
  readonly body?: string;
  readonly subject: ReadonlyArray<NotificationSubject>;
  /** The one event the notification was derived from, such as a `run.failed`. */
  readonly eventId?: EventId;
}

const NO_SUCH_NOTIFICATION = "no such notification";

/**
 * The refusal for a user who calls `notification.create`. The user holds every
 * grant, so the message has to say why the grant does not help.
 */
const USER_CANNOT_CREATE =
  "a notification is a message to you, so you cannot create one; a session or a workflow step creates it";

/** The refusal for a run that calls `notification.withdraw`. */
const RUN_CANNOT_WITHDRAW =
  "a run cannot withdraw a notification: it is the run's message to the user, and the run has ended";

/** The refusal for a caller who withdraws a notification someone else produced. */
const NOT_THE_PRODUCER = "only the producer of a notification may withdraw it";

/**
 * Returns the status a new notification starts in. A decision is open until it
 * is resolved; an informational notification has nothing to answer, so it is
 * resolved from the start. The only resolution it may carry is `handled`: an
 * assistant covered what it reports, so it was recorded without being pushed.
 */
const decideInitialStatus = (actions: ReadonlyArray<BoundAction>) =>
  actions.length > 0 ? ("open" as const) : ("resolved" as const);

/**
 * Returns the key that mutes a notification from this caller: the assistant a
 * session speaks for, or the stored workflow a run was started from. Returns
 * undefined when there is nothing to mute by: a session in no assistant's
 * conversation, or a run of a sent workflow.
 */
const decideMuteKey = (caller: SessionActor | RunActor): MuteKey | undefined => {
  if (caller._tag === "session") {
    return caller.assistantId === null ? undefined : `assistant:${caller.assistantId}`;
  }
  return caller.workflowId === null ? undefined : `workflow:${caller.workflowId}`;
};

/**
 * Shortens text to at most `max` characters, ending it with an ellipsis when
 * it had to be cut. The core builds titles and bodies from names and error
 * messages it does not control, and a stored notification longer than the
 * contract allows could not be returned by `notification.query` at all.
 */
const shortenTo = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** Checks whether a caller is the session that produced a notification. */
const isProducer = (actor: Actor, producer: NotificationProducer): actor is SessionActor =>
  actor._tag === "session" && producer.type === "session" && producer.sessionId === actor.sessionId;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const notifications = yield* notificationRepository;
  const audit = yield* AuditLog;

  const readOrFail = (id: string): Effect.Effect<Notification, NotFound | SqlError> =>
    Effect.flatMap(
      notifications.read(id),
      Option.match({
        onNone: () => Effect.fail(createNotFoundError(NO_SUCH_NOTIFICATION)),
        onSome: Effect.succeed,
      }),
    );

  /**
   * Writes a notification with its audit entry and announcement, in the
   * caller's transaction if there is one.
   */
  const insertAndAudit = (
    notification: NewNotification,
    actor: string,
  ): Effect.Effect<Notification, SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const stored = yield* notifications.insert(notification);
        yield* audit.append({
          kind: "notification.created",
          actor,
          record: { topic: "notification", id: stored.id },
          payload: {
            notificationId: stored.id,
            kind: stored.kind,
            producer: stored.producer,
          },
          at: stored.createdAt,
        });
        return stored;
      }),
    );

  return {
    /** Returns one page of the notifications that match a filter, newest first by default. */
    query: (
      input: QueryInput,
    ): Effect.Effect<NotificationPage, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("notification.query");
        const decoded = yield* Effect.mapError(decodeQuery(input), createDecodeValidationError);
        const { limit, cursor, sort, ...filter } = decoded;
        const listing = yield* refuseCursor(
          notifications.list(filter, {
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: sort?.direction ?? "desc",
          }),
        );
        return {
          items: listing.items,
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
      }),

    /** Returns one notification by id. Fails with `NotFound` if it does not exist. */
    read: (
      id: Id,
    ): Effect.Effect<Notification, Unauthenticated | Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("notification.read");
        return yield* readOrFail(id);
      }),

    /**
     * Creates a notification as the calling session or run step, and returns
     * its id. With actions it is an open decision; without, it is
     * informational and resolved from the start.
     *
     * Fails with:
     *
     * - `Forbidden` for the user, because notifications are messages to the
     *   user;
     * - `Validation` if the payload does not match the contract, which
     *   includes a `core.*` kind.
     */
    create: (
      input: NotificationCreateInput,
    ): Effect.Effect<
      NotificationCreateResult,
      Unauthenticated | Forbidden | Validation | SqlError
    > =>
      Effect.gen(function* () {
        const caller = yield* requireGrant("notification.create");
        if (caller._tag !== "session" && caller._tag !== "run") {
          return yield* Effect.fail(createForbiddenError("notification.write", USER_CANNOT_CREATE));
        }
        const decoded = yield* Effect.mapError(decodeCreate(input), createDecodeValidationError);
        const producer: NotificationProducer =
          caller._tag === "session"
            ? { type: "session", sessionId: caller.sessionId }
            : { type: "run", runId: caller.runId, stepId: caller.stepId };
        const muteKey = decideMuteKey(caller);
        const actions = decoded.actions ?? [];
        const stored = yield* insertAndAudit(
          {
            kind: decoded.kind,
            title: decoded.title,
            ...(decoded.body === undefined ? {} : { body: decoded.body }),
            producer,
            ...(muteKey === undefined ? {} : { muteKey }),
            subject: decoded.subject ?? [],
            actions,
            status: decideInitialStatus(actions),
            createdAt: yield* nowIso,
          },
          yield* currentStamp,
        );
        return { notificationId: stored.id };
      }),

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
     * Creates an informational notification the core raises about itself. It
     * runs in the caller's transaction, so the notification commits with the
     * change it reports. There is no grant check: only the controller calls it.
     *
     * A title or body longer than the contract allows is shortened, and an
     * empty body is left out, so a notification built from an error message
     * is always one `notification.query` can return.
     *
     * With `unlessRaisedSince`, it creates nothing when a notification of the
     * same kind, about every subject of this one, was created after that
     * instant. A condition that lasts, such as a runner that stays away, is
     * checked again and again; the option lets the caller report it once
     * each time it occurs rather than on every check. The caller passes the
     * instant the condition began, such as when the runner was last seen.
     */
    createCoreNotification: (
      notification: CoreNotification,
      options?: { readonly unlessRaisedSince?: string },
    ): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const since = options?.unlessRaisedSince;
          if (
            since !== undefined &&
            (yield* notifications.hasNotificationAboutSince(
              notification.kind,
              notification.subject,
              since,
            ))
          ) {
            return;
          }
          yield* insertAndAudit(
            {
              kind: notification.kind,
              title: shortenTo(notification.title, MAX_NOTIFICATION_TITLE_LENGTH),
              ...(notification.body === undefined || notification.body === ""
                ? {}
                : { body: shortenTo(notification.body, MAX_NOTIFICATION_BODY_LENGTH) }),
              producer: { type: "core" },
              subject: notification.subject,
              ...(notification.eventId === undefined ? {} : { eventId: notification.eventId }),
              actions: [],
              status: "resolved",
              createdAt: yield* nowIso,
            },
            SYSTEM_ACTOR,
          );
        }),
      ),

    /**
     * Withdraws every open decision about any of these subjects, because the
     * subject was removed and the question with it. It runs in the caller's
     * transaction, the one that removes the subject, and is stamped as the
     * core. There is no grant check: only the controller calls it.
     */
    withdrawDecisionsAbout: (
      subjects: ReadonlyArray<NotificationSubject>,
      reason: string,
    ): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const ids = yield* notifications.listOpenDecisionIdsAbout(subjects);
          if (ids.length === 0) return;
          const at = yield* nowIso;
          const resolution = {
            kind: "withdrawn" as const,
            actor: SYSTEM_ACTOR,
            origin: "core",
            reason,
            at,
          };
          yield* Effect.forEach(
            ids,
            (id) =>
              Effect.gen(function* () {
                yield* notifications.resolve(id, resolution);
                yield* audit.append({
                  kind: "notification.withdrawn",
                  actor: SYSTEM_ACTOR,
                  record: { topic: "notification", id },
                  payload: { notificationId: id, reason },
                  at,
                });
              }),
            { discard: true },
          );
        }),
      ),
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
  SqlClient.SqlClient | AuditLog
> = Layer.effect(NotificationService)(make);
