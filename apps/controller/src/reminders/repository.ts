/**
 * Reminder rows. This module only reads and writes them. Who may set or
 * cancel a reminder, and which conversation a caller may reach, are decided by
 * the service.
 *
 * A listing pages with a keyset over `at` and the id. It can be narrowed to
 * one conversation, which `reminders_by_conversation` serves, and to one
 * status. The Scheduler reads through `listDue` and moves a reminder out of
 * `pending` through `markFired`.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Reminder, ReminderStatus, SortDirection } from "@hercule/contract";
import {
  buildKeyset,
  buildPage,
  decodeCursor,
  encodeCursor,
  mintUuid,
  uuidFromString,
  uuidToString,
  type CursorError,
  type CursorScope,
  type Page,
} from "../db";

/** The fields of a new reminder row. The repository generates the id. */
export interface NewReminder {
  readonly conversationId: string;
  /** When the reminder fires, as a canonical UTC timestamp. */
  readonly at: string;
  readonly text: string;
  /** The instant the row is created, which is its `createdAt`. */
  readonly createdAt: string;
  readonly actor: string;
}

export interface ReminderPageRequest {
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly direction: SortDirection;
  /** Only this conversation's reminders, or every conversation's when undefined. */
  readonly conversationId: string | undefined;
  /** Only reminders in this status, or every status when undefined. */
  readonly status: ReminderStatus | undefined;
}

interface ReminderRow {
  readonly id: Uint8Array;
  readonly conversation_id: Uint8Array;
  readonly at: string;
  readonly text: string;
  readonly status: string;
  readonly actor: string;
  readonly created_at: string;
  readonly fired_at: string | null;
}

const COLUMNS = "id, conversation_id, at, text, status, actor, created_at, fired_at";

const toReminder = (row: ReminderRow): Reminder => ({
  id: uuidToString(row.id),
  conversationId: uuidToString(row.conversation_id),
  at: row.at,
  text: row.text,
  status: row.status as ReminderStatus,
  actor: row.actor,
  createdAt: row.created_at,
  firedAt: row.fired_at,
});

const buildCursorScope = (direction: SortDirection): CursorScope => ({
  op: "reminder.query",
  sort: [{ field: "at", direction }],
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /** Inserts a pending reminder and returns its new id. */
    insert: (reminder: NewReminder): Effect.Effect<string, SqlError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        yield* sql`
          INSERT INTO reminders (id, conversation_id, at, text, status, actor, created_at)
          VALUES (${id}, ${uuidFromString(reminder.conversationId)}, ${reminder.at},
                  ${reminder.text}, 'pending', ${reminder.actor}, ${reminder.createdAt})
        `;
        return uuidToString(id);
      }),

    /** Returns the reminder with the id, in any status, or `None` if there is none. */
    read: (id: string): Effect.Effect<Option.Option<Reminder>, SqlError> =>
      Effect.map(
        sql<ReminderRow>`
          SELECT ${sql.literal(COLUMNS)} FROM reminders WHERE id = ${uuidFromString(id)}`,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), toReminder),
      ),

    /** Returns whether a conversation with this id exists. */
    conversationExists: (conversationId: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly found: number }>`
          SELECT 1 AS found FROM conversations WHERE id = ${uuidFromString(conversationId)}`,
        (rows) => rows.length > 0,
      ),

    /**
     * Returns the conversation a session is part of. Returns `None` when the
     * session is in no conversation, which is every session that is not an
     * assistant's, and when there is no such session.
     */
    readSessionConversationId: (
      sessionId: string,
    ): Effect.Effect<Option.Option<string>, SqlError> =>
      Effect.map(
        sql<{ readonly conversation_id: Uint8Array | null }>`
          SELECT conversation_id FROM sessions WHERE id = ${uuidFromString(sessionId)}`,
        (rows) => {
          const conversationId = rows[0]?.conversation_id;
          return conversationId === null || conversationId === undefined
            ? Option.none()
            : Option.some(uuidToString(conversationId));
        },
      ),

    /**
     * Moves a pending reminder to `cancelled`. Returns true if it was
     * pending, and false if it was already fired or cancelled.
     */
    cancel: (id: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          UPDATE reminders SET status = 'cancelled'
          WHERE id = ${uuidFromString(id)} AND status = 'pending' RETURNING id`,
        (rows) => rows.length > 0,
      ),

    /**
     * Returns every pending reminder whose time is `now` or earlier, oldest
     * first. The Scheduler fires these. A reminder missed while the controller
     * was down is returned too, so it fires late rather than never. The list
     * is read whole, not paged, because the Scheduler fires all of it.
     */
    listDue: (now: string): Effect.Effect<ReadonlyArray<Reminder>, SqlError> =>
      Effect.map(
        sql<ReminderRow>`
          SELECT ${sql.literal(COLUMNS)} FROM reminders
          WHERE status = 'pending' AND at <= ${now} ORDER BY at, id`,
        (rows) => rows.map(toReminder),
      ),

    /**
     * Moves a pending reminder to `fired` and records when. Returns true if
     * this call moved it, and false if it was no longer pending, for example
     * because it was cancelled after the Scheduler read it. Only the caller
     * that gets true gives the text to the conversation.
     */
    markFired: (id: string, at: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          UPDATE reminders SET status = 'fired', fired_at = ${at}
          WHERE id = ${uuidFromString(id)} AND status = 'pending' RETURNING id`,
        (rows) => rows.length > 0,
      ),

    list: (request: ReminderPageRequest): Effect.Effect<Page<Reminder>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope = buildCursorScope(request.direction);
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeCursor(request.cursor, scope, ["string"]);
        const { keyset, order } = buildKeyset(
          sql,
          [{ column: "at", direction: request.direction }],
          ["id"],
          after === undefined ? undefined : [...after.values, uuidFromString(after.id)],
        );
        const inConversation =
          request.conversationId === undefined
            ? sql`1 = 1`
            : sql`conversation_id = ${uuidFromString(request.conversationId)}`;
        const withStatus =
          request.status === undefined ? sql`1 = 1` : sql`status = ${request.status}`;
        const rows = yield* sql<ReminderRow>`
          SELECT ${sql.literal(COLUMNS)} FROM reminders
          WHERE ${keyset} AND ${inConversation} AND ${withStatus}
          ${order} LIMIT ${request.limit + 1}
        `;
        return yield* buildPage(
          rows,
          request.limit,
          (page) => Effect.succeed(page.map(toReminder)),
          (last) => encodeCursor(scope, [last.at], last.id),
        );
      }),
  };
});

/** Everything the reminder service and the Scheduler read and write. */
export const reminderRepository = make;
