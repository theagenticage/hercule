/**
 * The notification operations: `notification.query`, `read`, `create` and
 * `withdraw`, plus the two the core uses for its own notifications.
 *
 * The producer is stamped from the caller, never taken from the payload:
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
  NOTIFICATION_SORT_FIELDS,
  NotificationCreateInput,
  NotificationFilter,
  NotificationWithdrawInput,
  type BoundAction,
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

/** The kinds the core produces. Every other producer is refused a `core.*` kind. */
export type CoreNotificationKind =
  | "core.run-failed"
  | "core.plugin-error"
  | "core.runner-unreachable"
  | "core.subscription-condition-error";

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
 * resolved from the start and never gets a resolution.
 */
const decideInitialStatus = (actions: ReadonlyArray<BoundAction>) =>
  actions.length > 0 ? ("open" as const) : ("resolved" as const);

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
   * Returns the key that mutes a producer: the workflow of a run, the
   * assistant of a session. Returns none when there is nothing to mute by: a
   * run of a sent workflow, or a session that speaks for no assistant.
   */
  const decideMuteKey = (
    producer: NotificationProducer,
  ): Effect.Effect<Option.Option<MuteKey>, SqlError> => {
    switch (producer.type) {
      case "run":
        return Effect.map(
          notifications.readRunWorkflowId(producer.runId),
          Option.map((id) => `workflow:${id}`),
        );
      case "session":
        return Effect.map(
          notifications.readSessionAssistantId(producer.sessionId),
          Option.map((id) => `assistant:${id}`),
        );
      case "plugin":
        return Effect.succeed(Option.some(`plugin:${producer.pluginId}`));
      case "core":
        return Effect.succeed(Option.none());
    }
  };

  /**
   * Writes a notification with its audit entry and announcement, in the
   * caller's transaction if there is one.
   */
  const insert = (
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
     * informational and resolved from the start. Fails with `Forbidden` for
     * the user, who is who notifications are for.
     */
    create: (
      input: NotificationCreateInput,
    ): Effect.Effect<
      NotificationCreateResult,
      Unauthenticated | Forbidden | Validation | SqlError
    > =>
      Effect.gen(function* () {
        const caller = yield* requireGrant("notification.create");
        const decoded = yield* Effect.mapError(decodeCreate(input), createDecodeValidationError);
        const producer: NotificationProducer | undefined =
          caller._tag === "session"
            ? { type: "session", sessionId: caller.sessionId }
            : caller._tag === "run"
              ? { type: "run", runId: caller.runId, stepId: caller.stepId }
              : undefined;
        if (producer === undefined) {
          return yield* Effect.fail(createForbiddenError("notification.write", USER_CANNOT_CREATE));
        }
        const actions = decoded.actions ?? [];
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const muteKey = yield* decideMuteKey(producer);
            const stored = yield* insert(
              {
                kind: decoded.kind,
                title: decoded.title,
                ...(decoded.body === undefined ? {} : { body: decoded.body }),
                producer,
                ...Option.match(muteKey, { onNone: () => ({}), onSome: (key) => ({ muteKey: key }) }),
                subject: decoded.subject ?? [],
                actions,
                status: decideInitialStatus(actions),
                createdAt: yield* nowIso,
              },
              yield* currentStamp,
            );
            return { notificationId: stored.id };
          }),
        );
      }),

    /**
     * Withdraws an open decision because its question stopped existing, and
     * returns it resolved. Only the session that produced a notification may
     * withdraw it.
     *
     * Fails with:
     *
     * - `NotFound` if the notification does not exist;
     * - `Forbidden` if the caller did not produce it, or is a run;
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
        const { reason } = yield* Effect.mapError(
          decodeWithdraw({ reason: input.reason }),
          createDecodeValidationError,
        );
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const notification = yield* readOrFail(input.id);
            if (caller._tag === "run") {
              return yield* Effect.fail(
                createForbiddenError("notification.write", RUN_CANNOT_WITHDRAW),
              );
            }
            if (!isProducer(caller, notification.producer)) {
              return yield* Effect.fail(createForbiddenError("notification.write", NOT_THE_PRODUCER));
            }
            if (notification.status !== "open") {
              return yield* Effect.fail(
                createInvalidStateError(
                  notification.actions.length === 0
                    ? "an informational notification has no question to withdraw"
                    : "the notification is already resolved",
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
            yield* notifications.resolve(input.id, resolution);
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
     * Creates an informational notification the core raises about itself, and
     * returns its id. It runs in the caller's transaction, so the notification
     * commits with the change it reports. There is no grant check: only the
     * controller calls it.
     */
    createCoreNotification: (notification: CoreNotification): Effect.Effect<Id, SqlError> =>
      Effect.gen(function* () {
        const stored = yield* insert(
          {
            kind: notification.kind,
            title: notification.title,
            ...(notification.body === undefined ? {} : { body: notification.body }),
            producer: { type: "core" },
            subject: notification.subject,
            ...(notification.eventId === undefined ? {} : { eventId: notification.eventId }),
            actions: [],
            status: "resolved",
            createdAt: yield* nowIso,
          },
          SYSTEM_ACTOR,
        );
        return stored.id;
      }),

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
          const ids = yield* notifications.listOpenAbout(subjects);
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
