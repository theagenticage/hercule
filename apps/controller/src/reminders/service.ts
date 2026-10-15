/**
 * The reminder operations: `reminder.create`, `query` and `cancel`.
 *
 * A reminder belongs to a conversation, and a session token may reach only
 * its own conversation's reminders. The session's conversation is read from
 * the session row, never from the payload, so an assistant cannot set,
 * list or cancel a reminder in a conversation that is not its own. A session
 * that names another conversation, or cancels another conversation's
 * reminder, gets the same `NotFound` a missing record gets, so it learns
 * nothing about what exists. A user credential, and a run, reach every
 * conversation, and must name the conversation when it creates a reminder.
 *
 * Firing a reminder is not here: the Scheduler reads `listDue` and calls
 * `markFired` on the repository.
 *
 * A method that takes only an id does not decode it again: the transport has
 * already decoded a request's id against the contract.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  DEFAULT_PAGE_LIMIT,
  REMINDER_SORT_FIELDS,
  ReminderFilter,
  createDecodeValidationError,
  createInvalidStateError,
  createNotFoundError,
  createValidationError,
  type Forbidden,
  type Id,
  type InvalidState,
  type NotFound,
  type Reminder,
  type ReminderCreateInput,
  type SortDirection,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { currentStamp, requireGrant, type Actor } from "../actor";
import {
  announce,
  buildPageInputFields,
  nowIso,
  refuseCursor,
  resolveSortDirection,
  withTransaction,
} from "../db";
import { reminderRepository } from "./repository";

const QueryInput = Schema.Struct({
  ...ReminderFilter.fields,
  ...buildPageInputFields(REMINDER_SORT_FIELDS),
});

type QueryInput = Schema.Schema.Type<typeof QueryInput>;

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);

interface ReminderPage {
  readonly items: ReadonlyArray<Reminder>;
  readonly nextCursor?: string;
}

/** Soonest first: a list of reminders reads as what is coming up. */
const DEFAULT_DIRECTION: SortDirection = "asc";

const NO_SUCH_CONVERSATION = "no such conversation";

const NO_SUCH_REMINDER = "no such reminder";

/**
 * The refusal of a session that is in no conversation, so it has no
 * reminders of its own. The summary and the `conversationId` message differ,
 * so a reader is not shown one sentence twice.
 */
const NO_CONVERSATION_SUMMARY = "this session has no conversation to set a reminder in";

const SET_NEEDS_CONVERSATION =
  "only an assistant's session can set a reminder on itself, and this session is in no conversation; " +
  "ask an assistant, or call this with a user credential and a conversationId";

const LIST_NEEDS_CONVERSATION =
  "only an assistant's session has reminders of its own, and this session is in no conversation; " +
  "call this with a user credential to list reminders";

/** The refusal of a user credential that creates a reminder without naming where it fires. */
const USER_NEEDS_CONVERSATION =
  "a user credential is not in a conversation, so it must say which conversation the reminder " +
  "fires in; pass conversationId";

/** The most pending reminders one conversation may have. */
export const MAX_PENDING_REMINDERS_PER_CONVERSATION = 100;

const TOO_MANY_PENDING =
  `this conversation already has ${MAX_PENDING_REMINDERS_PER_CONVERSATION} pending reminders, ` +
  "which is the most it can have; cancel some before setting another";

const NOT_IN_THE_FUTURE =
  "a reminder fires once, at its time, so a time that has passed would never fire; " +
  "give a time in the future";

/** The errors every operation here can fail with before it does its work. */
type CommonError = Unauthenticated | Forbidden | SqlError;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const reminders = yield* reminderRepository;

  /**
   * Returns the conversation of the calling session, or fails with
   * `Validation` carrying `whenNone` if the session is in no conversation.
   */
  const readOwnConversation = (
    sessionId: string,
    whenNone: string,
  ): Effect.Effect<string, Validation | SqlError> =>
    Effect.flatMap(reminders.readSessionConversationId(sessionId), (own) =>
      Option.isNone(own)
        ? Effect.fail(
            createValidationError(
              [{ path: ["conversationId"], message: whenNone }],
              NO_CONVERSATION_SUMMARY,
            ),
          )
        : Effect.succeed(own.value),
    );

  /** Records a change to the conversation for the live topic, once the transaction commits. */
  const nudge = (conversationId: string): Effect.Effect<void> =>
    announce({ _tag: "record", topic: "conversation", id: conversationId, kind: "updated" });

  /**
   * Returns the conversation a create or a query is about. A session gets
   * its own, and fails with `NotFound` if it names another. A user
   * credential gets the one it named, which is undefined if it named none.
   */
  const resolveConversation = (
    actor: Actor,
    named: Id | undefined,
    whenSessionHasNone: string,
  ): Effect.Effect<string | undefined, Validation | NotFound | SqlError> =>
    Effect.gen(function* () {
      if (actor._tag !== "session") return named;
      const own = yield* readOwnConversation(actor.sessionId, whenSessionHasNone);
      if (named !== undefined && named !== own) {
        return yield* Effect.fail(createNotFoundError(NO_SUCH_CONVERSATION));
      }
      return own;
    });

  return {
    /**
     * Sets a pending reminder and returns its id. Fails with:
     *
     * - `Validation` if a session is in no conversation, if a user
     *   credential names no conversation, or if `at` is not in the future;
     * - `NotFound` if the conversation does not exist, or if a session names
     *   a conversation other than its own;
     * - `Validation` also if the conversation already has
     *   `MAX_PENDING_REMINDERS_PER_CONVERSATION` pending reminders.
     */
    create: (
      input: ReminderCreateInput,
    ): Effect.Effect<{ readonly reminderId: string }, CommonError | Validation | NotFound> =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("reminder.create");
        const conversationId = yield* resolveConversation(
          actor,
          input.conversationId,
          SET_NEEDS_CONVERSATION,
        );
        if (conversationId === undefined) {
          return yield* Effect.fail(
            createValidationError(
              [{ path: ["conversationId"], message: USER_NEEDS_CONVERSATION }],
              "a reminder needs a conversation",
            ),
          );
        }
        const reminderId = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            if (!(yield* reminders.conversationExists(conversationId))) {
              return yield* Effect.fail(createNotFoundError(NO_SUCH_CONVERSATION));
            }
            const now = yield* nowIso;
            if (input.at <= now) {
              return yield* Effect.fail(
                createValidationError(
                  [{ path: ["at"], message: NOT_IN_THE_FUTURE }],
                  "the reminder's time is not in the future",
                ),
              );
            }
            if (
              (yield* reminders.countPending(conversationId)) >=
              MAX_PENDING_REMINDERS_PER_CONVERSATION
            ) {
              return yield* Effect.fail(
                createValidationError(
                  [{ path: ["conversationId"], message: TOO_MANY_PENDING }],
                  "the conversation has too many pending reminders",
                ),
              );
            }
            const id = yield* reminders.insert({
              conversationId,
              at: input.at,
              text: input.text,
              createdAt: now,
              actor: yield* currentStamp,
            });
            yield* nudge(conversationId);
            return id;
          }),
        );
        return { reminderId };
      }),

    /**
     * Returns a page of reminders, soonest first by default. A session gets
     * its own conversation's, and fails with `NotFound` if it names another
     * conversation. A user credential gets every conversation's, or the one
     * it names, and fails with `NotFound` if that conversation does not
     * exist.
     */
    query: (input: QueryInput): Effect.Effect<ReminderPage, CommonError | Validation | NotFound> =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("reminder.query");
        const {
          conversationId: named,
          status,
          limit,
          cursor,
          sort,
        } = yield* Effect.mapError(decodeQuery(input), createDecodeValidationError);
        const conversationId = yield* resolveConversation(actor, named, LIST_NEEDS_CONVERSATION);
        if (
          conversationId !== undefined &&
          !(yield* reminders.conversationExists(conversationId))
        ) {
          return yield* Effect.fail(createNotFoundError(NO_SUCH_CONVERSATION));
        }
        const listing = yield* refuseCursor(
          reminders.list({
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: resolveSortDirection(sort, DEFAULT_DIRECTION),
            conversationId,
            status,
          }),
        );
        return {
          items: listing.items,
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
      }),

    /**
     * Cancels a pending reminder. Fails with:
     *
     * - `NotFound` if there is no such reminder, or if a session cancels a
     *   reminder of a conversation other than its own. The two cases fail the
     *   same way, so a session learns nothing about reminders it may not reach;
     * - `InvalidState` if the reminder has already fired or was cancelled.
     */
    cancel: (id: Id): Effect.Effect<Record<string, never>, CommonError | NotFound | InvalidState> =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("reminder.cancel");
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const found = yield* reminders.read(id);
            if (Option.isNone(found)) {
              return yield* Effect.fail(createNotFoundError(NO_SUCH_REMINDER));
            }
            const reminder = found.value;
            if (actor._tag === "session") {
              const own = yield* reminders.readSessionConversationId(actor.sessionId);
              if (Option.isNone(own) || own.value !== reminder.conversationId) {
                return yield* Effect.fail(createNotFoundError(NO_SUCH_REMINDER));
              }
            }
            if (!(yield* reminders.cancel(id, yield* nowIso, yield* currentStamp))) {
              return yield* Effect.fail(
                createInvalidStateError(
                  `the reminder has already ${reminder.status === "fired" ? "fired" : "been cancelled"}, ` +
                    "so there is nothing left to cancel",
                ),
              );
            }
            yield* nudge(reminder.conversationId);
          }),
        );
        return {};
      }),
  };
});

/** The reminder service. */
export class Reminders extends Context.Service<Reminders, Effect.Success<typeof make>>()(
  "hercule/controller/reminders/Reminders",
) {}

export const RemindersLayer: Layer.Layer<Reminders, never, SqlClient.SqlClient> =
  Layer.effect(Reminders)(make);
