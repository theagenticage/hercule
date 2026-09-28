/**
 * The notification operations: `notification.query`, `read`, `create` and
 * `withdraw`, plus the methods the controller calls for the core's own
 * notifications and for decisions answered elsewhere: `createCoreNotification`,
 * `decide`, `answerDecisionsAbout` and `withdrawDecisionsAbout`.
 * `notification.act` runs an answer's operation, which reaches domains above
 * this one, so it lives in the controller daemon and calls `decide`.
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
 * The user reads every notification but creates none: a notification is a
 * message to the user. A session or a run reads only the notifications it
 * produced.
 *
 * An answer's operation is checked when the notification is created: it must
 * be one an answer may run, its input must fit that operation, and the
 * producer must be allowed to bind it (`checkProducerMayBind`). An open
 * decision is returned to the user with each answer's describe line, written
 * from the current names by the `BoundOperationDescriber` port.
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
  createValidationError,
  decodeBindableOperation,
  DEFAULT_PAGE_LIMIT,
  MAX_NOTIFICATION_BODY_LENGTH,
  MAX_NOTIFICATION_TITLE_LENGTH,
  NOTIFICATION_SORT_FIELDS,
  NotificationCreateInput,
  NotificationFilter,
  NotificationWithdrawInput,
  OWN_SESSION_ALIAS,
  truncateText,
  type BindableOperation,
  type BoundAction,
  type BoundOperation,
  type CoreNotificationKind,
  type DescribeLine,
  type EventId,
  type Forbidden,
  type Id,
  type InvalidState,
  type MuteKey,
  type NotFound,
  type Notification,
  type NotificationAction,
  type NotificationCreateResult,
  type NotificationProducer,
  type NotificationSubject,
  type ResolutionOrigin,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import {
  buildSessionStamp,
  CurrentActor,
  currentStamp,
  requireGrant,
  SYSTEM_ACTOR,
  type Actor,
  type RunActor,
  type SessionActor,
} from "../actor";
import { buildPageInputFields, nowIso, refuseCursor, withTransaction } from "../db";
import { AuditLog } from "../events";
import { BoundOperationDescriber } from "./describer";
import { notificationRepository, type NewNotification, type ProducerScope } from "./repository";

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

/** One answer of a decision the core raises. The core builds its operations, so they are typed. */
export interface CoreAction {
  readonly id: string;
  readonly label: string;
  /** What choosing this answer means, shown as fine print under the answer. */
  readonly description?: string;
  readonly operation: BindableOperation | null;
  readonly primary?: boolean;
}

/** A notification the core raises about itself. With actions it is a decision. */
export interface CoreNotification {
  readonly kind: CoreNotificationKind;
  readonly title: string;
  readonly body?: string;
  readonly subject: ReadonlyArray<NotificationSubject>;
  /** The one event the notification was derived from, such as a `run.failed`. */
  readonly eventId?: EventId;
  readonly actions?: ReadonlyArray<CoreAction>;
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

/** The describe line of an answer that runs nothing. */
const NO_OPERATION_DESCRIBE_LINE: DescribeLine = [{ kind: "text", text: "Does nothing" }];

/**
 * The refusal for a producer that binds `session.respond` to an answer. The
 * core raises the decision about each approval request itself, with the
 * request's own answers.
 */
const PRODUCER_CANNOT_RESPOND =
  "An answer cannot run session.respond: the core raises the decision about each approval request itself, with the request's own answers. To ask the user a question, bind session.input instead.";

/**
 * The refusal for a session that binds `session.input` to another session.
 * The user's answer would steer a session that never asked the question.
 */
const SESSION_INPUT_ONLY_TO_ITSELF = `A session can bind session.input only to itself, so the user's answer comes back to the session that asked. Use "${OWN_SESSION_ALIAS}" as the session id.`;

/**
 * The refusal for a session in an assistant's conversation that binds
 * `session.input` to itself. Such a session takes input only through
 * `conversation.send`, so taking the answer would always fail.
 */
const CONVERSATION_SESSION_CANNOT_TAKE_INPUT =
  "This session takes input only through conversation.send, so an answer cannot send input to it. Ask the question in the conversation instead.";

/**
 * Replaces the own-session alias `me` in an answer's input with the calling
 * session's id, so the stored answer names the session it will act on.
 * Returns the operation unchanged when its input does not use the alias.
 * Fails with `Validation` when a run's step uses it, because a run is not a
 * session.
 */
const replaceOwnSessionAlias = (
  operation: BoundOperation,
  caller: SessionActor | RunActor,
  path: ReadonlyArray<string>,
): Effect.Effect<BoundOperation, Validation> => {
  const { input } = operation;
  if (typeof input !== "object" || input === null || !("sessionId" in input)) {
    return Effect.succeed(operation);
  }
  if (input.sessionId !== OWN_SESSION_ALIAS) return Effect.succeed(operation);
  if (caller._tag === "run") {
    return Effect.fail(
      createValidationError([
        {
          path: [...path, "input", "sessionId"],
          message: `"${OWN_SESSION_ALIAS}" names the calling session, and a workflow step is not a session. Name the session by its id.`,
        },
      ]),
    );
  }
  return Effect.succeed({ ...operation, input: { ...input, sessionId: caller.sessionId } });
};

/**
 * Checks the rules that depend on who produces an answer, after the answer's
 * operation was decoded. Fails with `Validation` when:
 *
 * - the answer runs `session.respond`, which only the core binds;
 * - a session binds `session.input` to a session other than itself;
 * - a session in an assistant's conversation binds `session.input` to
 *   itself, which it cannot take.
 *
 * A run's step may bind `session.input` to any session.
 */
const checkProducerMayBind = (
  operation: BindableOperation,
  caller: SessionActor | RunActor,
  path: ReadonlyArray<string>,
): Effect.Effect<void, Validation> => {
  const refuse = (field: string, message: string) =>
    Effect.fail(createValidationError([{ path: [...path, field], message }]));
  if (operation.op === "session.respond") return refuse("op", PRODUCER_CANNOT_RESPOND);
  if (operation.op !== "session.input" || caller._tag === "run") return Effect.void;
  if (operation.input.sessionId !== caller.sessionId) {
    return refuse("input", SESSION_INPUT_ONLY_TO_ITSELF);
  }
  // A session speaks for an assistant exactly when it belongs to a conversation.
  if (caller.assistantId !== null) return refuse("input", CONVERSATION_SESSION_CANNOT_TAKE_INPUT);
  return Effect.void;
};

/**
 * Returns where a decision was resolved, from the actor who resolved it: the
 * web app for a user signed in there, the API for a user with an API key, the
 * session for a session, and the core for anything the controller did itself.
 */
const buildResolutionOrigin = (actor: Actor): ResolutionOrigin => {
  switch (actor._tag) {
    case "user":
      return actor.credential.kind === "login" ? "web" : "api";
    case "session":
      return buildSessionStamp(actor.sessionId);
    case "run":
    case "none":
      return "core";
  }
};

/** Checks whether a caller is the session that produced a notification. */
const isProducer = (actor: Actor, producer: NotificationProducer): actor is SessionActor =>
  actor._tag === "session" && producer.type === "session" && producer.sessionId === actor.sessionId;

/**
 * Returns the producer whose notifications a caller may read: its own session
 * or run. Returns undefined for the user, who reads every notification.
 */
const buildReadableScope = (caller: Actor): ProducerScope | undefined => {
  switch (caller._tag) {
    case "session":
      return { type: "session", sessionId: caller.sessionId };
    case "run":
      return { type: "run", runId: caller.runId };
    case "user":
    case "none":
      return undefined;
  }
};

/** Checks whether a notification was produced by the session or run a scope names. */
const isInScope = (notification: Notification, scope: ProducerScope): boolean => {
  const { producer } = notification;
  return scope.type === "session"
    ? producer.type === "session" && producer.sessionId === scope.sessionId
    : producer.type === "run" && producer.runId === scope.runId;
};

/**
 * An answer's operation after the check at read time: decoded, or refused
 * with the describe line that says why the answer cannot be taken.
 */
type CheckedOperation =
  | { readonly _tag: "decoded"; readonly operation: BindableOperation }
  | { readonly _tag: "refused"; readonly describeLine: DescribeLine };

/**
 * What `answerDecisionsAbout` found about a subject, and did:
 *
 * - `decided`: at least one open decision about it offered the answer, and is
 *   now decided with that answer;
 * - `already-decided`, `already-handled`, `already-withdrawn`: no decision
 *   about it is open, and the one resolved last was resolved that way. The
 *   question was settled by an answer or by an assistant, or it stopped
 *   existing;
 * - `none`: nothing was decided and nothing was resolved before. Either no
 *   decision lists the subject, or the open ones do not offer the answer.
 */
export type AnsweredDecisionsOutcome =
  "decided" | "already-decided" | "already-handled" | "already-withdrawn" | "none";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const notifications = yield* notificationRepository;
  const audit = yield* AuditLog;
  const describer = yield* BoundOperationDescriber;

  /**
   * Checks an answer's stored operation again before it is described. A
   * stored answer whose operation no longer passes the check, because the
   * list of operations an answer may run or a schema changed since it was
   * created, cannot be taken, and its describe line says why.
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
      const lines = yield* describer.describe(
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

  /**
   * Checks each answer's operation, after replacing the own-session alias
   * with the caller's session, and returns the answers with their decoded
   * inputs. Fails with `Validation` naming the first answer that does not
   * pass: its operation is not one an answer may run, its input does not fit,
   * or this caller may not bind it (`checkProducerMayBind`).
   */
  const checkActions = (
    actions: ReadonlyArray<BoundAction>,
    caller: SessionActor | RunActor,
  ): Effect.Effect<ReadonlyArray<BoundAction>, Validation> =>
    Effect.forEach(actions, (action, index) =>
      Effect.gen(function* () {
        if (action.operation === null) return action;
        const path = ["actions", String(index), "operation"];
        const replaced = yield* replaceOwnSessionAlias(action.operation, caller, path);
        const operation = yield* decodeBindableOperation(replaced, path);
        yield* checkProducerMayBind(operation, caller, path);
        return { ...action, operation };
      }),
    );

  /**
   * Resolves an open decision as decided with one of its answers, stamped
   * with the current actor, and records a `notification.decided` audit entry.
   * Returns false, and writes nothing, when the decision is no longer open.
   */
  const resolveAsDecided = (
    notification: Notification,
    action: BoundAction,
  ): Effect.Effect<boolean, SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const actor = yield* currentStamp;
        const at = yield* nowIso;
        const resolved = yield* notifications.resolve(notification.id, {
          kind: "decided",
          actionId: action.id,
          actor,
          origin: buildResolutionOrigin(yield* CurrentActor),
          at,
        });
        if (!resolved) return false;
        yield* audit.append({
          kind: "notification.decided",
          actor,
          record: { topic: "notification", id: notification.id },
          payload: {
            notificationId: notification.id,
            actionId: action.id,
            op: action.operation?.op ?? null,
            producer: notification.producer,
          },
          at,
        });
        return true;
      }),
    );

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
    /**
     * Returns one page of the notifications that match a filter, newest
     * first by default. A session or a run sees only the notifications it
     * produced. The describe lines are added only for the user, the only
     * caller who can take an answer.
     */
    query: (
      input: QueryInput,
    ): Effect.Effect<NotificationPage, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        const caller = yield* requireGrant("notification.query");
        const decoded = yield* Effect.mapError(decodeQuery(input), createDecodeValidationError);
        const { limit, cursor, sort, ...filter } = decoded;
        const listing = yield* refuseCursor(
          notifications.list(
            filter,
            {
              limit: limit ?? DEFAULT_PAGE_LIMIT,
              cursor,
              direction: sort?.direction ?? "desc",
            },
            buildReadableScope(caller),
          ),
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
     * not exist, or if the caller is a session or a run that did not produce
     * it.
     */
    read: (
      id: Id,
    ): Effect.Effect<Notification, Unauthenticated | Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        const caller = yield* requireGrant("notification.read");
        const notification = yield* readOrFail(id);
        const scope = buildReadableScope(caller);
        if (scope !== undefined && !isInScope(notification, scope)) {
          return yield* Effect.fail(createNotFoundError(NO_SUCH_NOTIFICATION));
        }
        return caller._tag === "user" ? yield* addDescribeLines(notification) : notification;
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
     *   includes a `core.*` kind, or if an answer's operation is not one this
     *   caller may bind or its input does not fit that operation.
     *
     * The own-session alias `me` in an answer's input is replaced with the
     * calling session's id before the answer is stored.
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
        const actions = yield* checkActions(decoded.actions ?? [], caller);
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
     * - `Forbidden` if the caller is a run or the user;
     * - `NotFound` if the notification does not exist, or if the caller is a
     *   session that did not produce it;
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
            // Another session cannot read this notification, so it is told
            // the notification does not exist, the same answer a read gives.
            const scope = buildReadableScope(caller);
            if (scope !== undefined && !isInScope(notification, scope)) {
              return yield* Effect.fail(createNotFoundError(NO_SUCH_NOTIFICATION));
            }
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
     * Creates a notification the core raises about itself: informational, or
     * a decision when it has actions. It runs in the caller's transaction, so
     * the notification commits with the change it reports. There is no grant
     * check: only the controller calls it.
     *
     * A title or body longer than the contract allows is shortened, and an
     * empty body is left out, so a notification built from an error message
     * is always one `notification.query` can return. The answers are never
     * shortened: their describe lines show every value in full.
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
              // `truncateText` appends three dots, so it keeps three characters fewer.
              title: truncateText(notification.title, MAX_NOTIFICATION_TITLE_LENGTH - 3),
              ...(notification.body === undefined || notification.body === ""
                ? {}
                : { body: truncateText(notification.body, MAX_NOTIFICATION_BODY_LENGTH - 3) }),
              producer: { type: "core" },
              subject: notification.subject,
              ...(notification.eventId === undefined ? {} : { eventId: notification.eventId }),
              actions: notification.actions ?? [],
              status: decideInitialStatus(notification.actions ?? []),
              createdAt: yield* nowIso,
            },
            SYSTEM_ACTOR,
          );
        }),
      ),

    /**
     * Resolves an open decision as decided with the answer `actionId`,
     * stamped with the current actor. `notification.act` calls it when the
     * user takes an answer. It reads the decision in its own transaction, or
     * in the caller's when there is one. Returns false, and writes nothing,
     * when the decision does not exist, is no longer open or has no such
     * answer. There is no grant check: only the controller calls it.
     */
    decide: (notificationId: Id, actionId: string): Effect.Effect<boolean, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const found = yield* notifications.read(notificationId);
          if (Option.isNone(found)) return false;
          const action = found.value.actions.find((candidate) => candidate.id === actionId);
          return action === undefined ? false : yield* resolveAsDecided(found.value, action);
        }),
      ),

    /**
     * Resolves the open decisions about a subject that offer the answer
     * `actionId`, as decided with that answer. The question was answered
     * some other way, such as an approval answered in the session view, so
     * the notification says which answer was taken. Returns what it found
     * and did (`AnsweredDecisionsOutcome`), so the caller can refuse a second
     * answer to a question that is already settled or no longer exists.
     *
     * It runs in the caller's transaction, the one that records the answer,
     * and is stamped with the current actor. There is no grant check: only
     * the controller calls it.
     */
    answerDecisionsAbout: (
      subject: NotificationSubject,
      actionId: string,
    ): Effect.Effect<AnsweredDecisionsOutcome, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const open = yield* notifications.listOpenDecisionsAbout([subject]);
          if (open.length === 0) {
            const resolvedKind = yield* notifications.readLatestResolutionKindAbout(subject);
            return Option.match(resolvedKind, {
              onNone: (): AnsweredDecisionsOutcome => "none",
              onSome: (kind): AnsweredDecisionsOutcome => `already-${kind}`,
            });
          }
          let outcome: AnsweredDecisionsOutcome = "none";
          for (const notification of open) {
            const action = notification.actions.find((candidate) => candidate.id === actionId);
            if (action !== undefined && (yield* resolveAsDecided(notification, action))) {
              outcome = "decided";
            }
          }
          return outcome;
        }),
      ),

    /**
     * Withdraws every open decision about any of these subjects, because the
     * subject was removed or stopped waiting for an answer, and the question
     * went with it. It runs in the caller's transaction, the one that removes
     * the subject, and is stamped as the core. There is no grant check: only
     * the controller calls it.
     */
    withdrawDecisionsAbout: (
      subjects: ReadonlyArray<NotificationSubject>,
      reason: string,
    ): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const open = yield* notifications.listOpenDecisionsAbout(subjects);
          if (open.length === 0) return;
          const at = yield* nowIso;
          const resolution = {
            kind: "withdrawn" as const,
            actor: SYSTEM_ACTOR,
            origin: "core",
            reason,
            at,
          };
          yield* Effect.forEach(
            open,
            ({ id }) =>
              Effect.gen(function* () {
                // A decision resolved since it was listed keeps that
                // resolution, and nothing was withdrawn to record.
                if (!(yield* notifications.resolve(id, resolution))) return;
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
  SqlClient.SqlClient | AuditLog | BoundOperationDescriber
> = Layer.effect(NotificationService)(make);
