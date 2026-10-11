/**
 * The service that writes notifications: it creates them, and resolves or
 * withdraws decisions. Every producer goes through it: a session or a run
 * step with `notification.create`, and the core for its own notifications
 * and for decisions whose question was answered or stopped existing
 * elsewhere.
 *
 * This is a service of its own, apart from `NotificationService`, because
 * the producers sit below the notification service in the layer graph.
 * `notification.act` runs operations of the tasks, runs and sessions
 * domains, and those domains raise and withdraw notifications. Writing them
 * through the notification service would make those layers need each other.
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
 * An answer's operation is checked when the notification is created: it must
 * be one an answer may run, its input must fit that operation, and the
 * producer must be allowed to bind it (`checkProducerMayBind`).
 *
 * Every write records one audit entry in the same transaction and announces
 * the change on the `notification` live topic. Muting decides only whether a
 * notification is pushed to a delivery sink. No sink exists yet, so the mute
 * key is recorded on the notification and nothing reads it here.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  createDecodeValidationError,
  createForbiddenError,
  createValidationError,
  decodeAnswerOperation,
  MAX_NOTIFICATION_BODY_LENGTH,
  MAX_NOTIFICATION_TITLE_LENGTH,
  NotificationCreateInput,
  OWN_SESSION_ALIAS,
  truncateText,
  type AnswerOperation,
  type AnswerOperationId,
  type BoundAction,
  type BoundOperation,
  type CoreNotificationKind,
  type EventId,
  type Forbidden,
  type MuteKey,
  type Notification,
  type NotificationCreateResult,
  type NotificationProducer,
  type NotificationSubject,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import {
  buildResolutionOrigin,
  CurrentActor,
  currentStamp,
  requireGrant,
  SYSTEM_ACTOR,
  type RunActor,
  type SessionActor,
} from "../actor";
import { nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import { notificationRepository, type NewNotification } from "./repository";

const decodeCreate = Schema.decodeUnknownEffect(NotificationCreateInput);

/** One answer of a decision the core raises. The core builds its operations, so they are typed. */
export interface CoreAction {
  readonly id: string;
  readonly label: string;
  /** What choosing this answer means, shown as fine print under the answer. */
  readonly description?: string;
  readonly operation: AnswerOperation<"notification.answer"> | null;
  readonly primary?: boolean;
}

/**
 * When a core notification is held back: when one of the same kind was
 * created about every subject in `about`, either
 *
 * - after `since`, such as the instant a lasting condition began, or
 * - `within` this long before now: a quiet period, for a condition that comes
 *   back again and again.
 *
 * `about` is every subject of the new notification when left out.
 */
export type UnlessRaised = ({ readonly since: string } | { readonly within: Duration.Duration }) & {
  readonly about?: ReadonlyArray<NotificationSubject>;
};

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

/**
 * The result of `answerDecisionsAbout` for one subject:
 *
 * - `decided`: at least one open decision about the subject offered the
 *   answer, and is now decided with that answer;
 * - `already-decided`, `already-handled`, `already-withdrawn`: no decision
 *   about the subject is open, and the most recently resolved one was
 *   resolved that way. Its question was answered, handled by an assistant, or
 *   stopped existing;
 * - `none`: nothing was decided and nothing was resolved before. Either no
 *   decision lists the subject, or the open ones do not offer the answer.
 */
export type AnsweredDecisionsOutcome =
  "decided" | "already-decided" | "already-handled" | "already-withdrawn" | "none";

/**
 * The refusal for a user who calls `notification.create`. The user holds every
 * grant, so the message has to say why the grant does not help.
 */
const USER_CANNOT_CREATE =
  "a notification is a message to you, so you cannot create one; a session or a workflow step creates it";

/**
 * The operations only the core binds to an answer, each with the refusal a
 * producer that binds it gets. The core raises the decision about each
 * approval request and each Permission Request itself, with that request's
 * own answers. A producer that could bind these operations could make the
 * user approve something other than what the answer shows.
 */
const CORE_ONLY_OPERATIONS: Partial<Record<AnswerOperationId<"notification.answer">, string>> = {
  "session.respondToApprovalRequest":
    "An answer cannot run session.respondToApprovalRequest: the core raises the decision about each approval request itself, with the request's own answers. To ask the user a question, bind session.input instead.",
  "permission.decide":
    "An answer cannot run permission.decide: the core raises the decision about each Permission Request itself, with the request's own answers. To ask for a grant, call permission.request instead.",
};

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
 * - the answer runs an operation only the core binds (`CORE_ONLY_OPERATIONS`);
 * - a session binds `session.input` to a session other than itself;
 * - a session in an assistant's conversation binds `session.input` to
 *   itself, which it cannot take.
 *
 * A run's step may bind `session.input` to any session.
 */
const checkProducerMayBind = (
  operation: AnswerOperation<"notification.answer">,
  caller: SessionActor | RunActor,
  path: ReadonlyArray<string>,
): Effect.Effect<void, Validation> => {
  const refuse = (field: string, message: string) =>
    Effect.fail(createValidationError([{ path: [...path, field], message }]));
  const coreOnly = CORE_ONLY_OPERATIONS[operation.op];
  if (coreOnly !== undefined) return refuse("op", coreOnly);
  if (operation.op !== "session.input" || caller._tag === "run") return Effect.void;
  if (operation.input.sessionId !== caller.sessionId) {
    return refuse("input", SESSION_INPUT_ONLY_TO_ITSELF);
  }
  // A session has an assistant id exactly when it belongs to an assistant's conversation.
  if (caller.assistantId !== null) return refuse("input", CONVERSATION_SESSION_CANNOT_TAKE_INPUT);
  return Effect.void;
};

/**
 * Checks each answer's operation, after replacing the own-session alias with
 * the caller's session, and returns the answers with their decoded inputs.
 * Fails with `Validation` naming the first answer that does not pass: its
 * operation is not one an answer may run, its input does not fit, or this
 * caller may not bind it (`checkProducerMayBind`).
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
      const operation = yield* decodeAnswerOperation("notification.answer", replaced, path);
      yield* checkProducerMayBind(operation, caller, path);
      return { ...action, operation };
    }),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const notifications = yield* notificationRepository;
  const audit = yield* AuditLog;

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

  /**
   * Resolves an open decision as decided with one of its answers, stamped
   * with the current actor, and records a `notification.decided` audit entry.
   * Returns false, and writes nothing, when the decision is no longer open.
   * It runs in the caller's transaction if there is one.
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

  return {
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
     * With `unlessRaised`, it creates nothing when a notification of the
     * same kind was already created about every subject in `about`, which is
     * every subject of this notification when left out, recently enough (see
     * `UnlessRaised`). A condition that lasts, such as a runner that stays
     * away, is checked again and again; the option lets the caller report it
     * once each time it occurs rather than on every check. `about` names
     * fewer subjects when each notification also names something of its own,
     * such as the run in a failed run's notification.
     */
    createCoreNotification: (
      notification: CoreNotification,
      options?: { readonly unlessRaised?: UnlessRaised | undefined },
    ): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const now = yield* nowIso;
          const unlessRaised = options?.unlessRaised;
          if (
            unlessRaised !== undefined &&
            (yield* notifications.hasNotificationAboutSince(
              notification.kind,
              unlessRaised.about ?? notification.subject,
              "since" in unlessRaised
                ? unlessRaised.since
                : new Date(Date.parse(now) - Duration.toMillis(unlessRaised.within)).toISOString(),
            ))
          ) {
            return;
          }
          yield* insertAndAudit(
            {
              kind: notification.kind,
              // `truncateText` appends "..." after `max` characters, so `max` is the limit minus three.
              title: truncateText(notification.title, MAX_NOTIFICATION_TITLE_LENGTH - 3),
              ...(notification.body === undefined || notification.body === ""
                ? {}
                : { body: truncateText(notification.body, MAX_NOTIFICATION_BODY_LENGTH - 3) }),
              producer: { type: "core" },
              subject: notification.subject,
              ...(notification.eventId === undefined ? {} : { eventId: notification.eventId }),
              actions: notification.actions ?? [],
              status: decideInitialStatus(notification.actions ?? []),
              createdAt: now,
            },
            SYSTEM_ACTOR,
          );
        }),
      ),

    /**
     * Resolves an open decision as decided with one of its answers, stamped
     * with the current actor. `notification.act` calls it when the user takes
     * an answer. It runs in the caller's transaction if there is one. Returns
     * false, and writes nothing, when the decision is no longer open. There is
     * no grant check: only the controller calls it.
     */
    decide: resolveAsDecided,

    /**
     * Resolves the open decisions about a subject that offer the answer
     * `actionId`, as decided with that answer. The controller calls it when
     * the question was answered somewhere else, such as an approval answered
     * in the session view, so the notification records which answer was
     * taken. Returns an `AnsweredDecisionsOutcome`, so the caller can reject a
     * second answer to a question that is already settled or no longer
     * exists.
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
                // A decision resolved since it was listed keeps its
                // resolution, so there is no withdrawal to audit.
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

/** The service that creates notifications and resolves or withdraws decisions. */
export class Notifier extends Context.Service<Notifier, Effect.Success<typeof make>>()(
  "hercule/controller/notifications/Notifier",
) {}

/** The notifier. It needs only the database and the audit log. */
export const NotifierLayer: Layer.Layer<Notifier, never, SqlClient.SqlClient | AuditLog> =
  Layer.effect(Notifier)(make);
