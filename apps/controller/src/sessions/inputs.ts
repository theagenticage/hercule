/**
 * The rows behind a session's inputs. Session-owned state, so it lives beside
 * the session's own repository rather than in a domain of its own.
 *
 * Nothing here decides whether an input is sent or held: that is the service's,
 * and the queue is only ever "the rows still `queued`".
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Delivery } from "@hercule/protocol";
import type { InputSource, InputStatus, SortDirection } from "@hercule/contract";
import {
  decodeCursor,
  encodeCursor,
  keysetOver,
  mintUuid,
  pageOf,
  uuidFromString,
  uuidToString,
  type CursorError,
  type CursorScope,
  type Page,
} from "../db";

export interface StoredInput {
  readonly id: string;
  readonly sessionId: string;
  readonly source: InputSource;
  readonly actor: string;
  readonly text: string;
  readonly status: InputStatus;
  readonly delivery: Delivery | null;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
  /** Set while the row is out on the wire and unanswered; null otherwise. */
  readonly sentAt: string | null;
  /** Why a delivery did not go through, on a row still queued or ended by one; null otherwise. */
  readonly reason: string | null;
}

export interface NewInput {
  readonly sessionId: string;
  readonly source: InputSource;
  readonly actor: string;
  readonly text: string;
  readonly at: string;
  /**
   * Set to claim the row inside this same insert, for an input reaching an
   * idle session: there is no separate claim to lose a race to, because
   * nothing else can see the row before this transaction commits.
   */
  readonly sentAt?: string;
}

export interface InputPageRequest {
  readonly sessionId: string;
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly direction: SortDirection;
}

interface InputRow {
  readonly id: Uint8Array;
  readonly session_id: Uint8Array;
  readonly source: string;
  readonly actor: string;
  readonly text: string;
  readonly status: string;
  readonly delivery: string | null;
  readonly created_at: string;
  readonly delivered_at: string | null;
  readonly sent_at: string | null;
  readonly reason: string | null;
}

const COLUMNS =
  "id, session_id, source, actor, text, status, delivery, created_at, delivered_at, sent_at, reason";

const toInput = (row: InputRow): StoredInput => ({
  id: uuidToString(row.id),
  sessionId: uuidToString(row.session_id),
  source: row.source as InputSource,
  actor: row.actor,
  text: row.text,
  status: row.status as InputStatus,
  delivery: row.delivery as Delivery | null,
  createdAt: row.created_at,
  deliveredAt: row.delivered_at,
  sentAt: row.sent_at,
  reason: row.reason,
});

/**
 * The walk is per session, so the session is part of the scope the cursor
 * belongs to: without it one session's cursor would silently hide rows on
 * another's list.
 */
const scopeOf = (sessionId: string, direction: SortDirection): CursorScope => ({
  op: "input.query",
  field: `createdAt:${sessionId}`,
  direction,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    insert: (input: NewInput): Effect.Effect<StoredInput, SqlError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        const sentAt = input.sentAt ?? null;
        yield* sql`
          INSERT INTO session_inputs (id, session_id, source, actor, text, status, created_at, sent_at)
          VALUES (${id}, ${uuidFromString(input.sessionId)}, ${input.source}, ${input.actor},
                  ${input.text}, 'queued', ${input.at}, ${sentAt})
        `;
        return {
          id: uuidToString(id),
          sessionId: input.sessionId,
          source: input.source,
          actor: input.actor,
          text: input.text,
          status: "queued",
          delivery: null,
          createdAt: input.at,
          deliveredAt: null,
          sentAt,
          reason: null,
        };
      }),

    /** Scoped by the session, so an id belonging to another one is simply not here. */
    one: (sessionId: string, id: string): Effect.Effect<Option.Option<StoredInput>, SqlError> =>
      Effect.map(
        sql<InputRow>`
          SELECT ${sql.literal(COLUMNS)} FROM session_inputs
          WHERE id = ${uuidFromString(id)} AND session_id = ${uuidFromString(sessionId)}
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), toInput),
      ),

    list: (request: InputPageRequest): Effect.Effect<Page<StoredInput>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope = scopeOf(request.sessionId, request.direction);
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeCursor(request.cursor, scope, "string");
        const { keyset, order } = keysetOver(
          sql,
          ["created_at", "id"],
          after === undefined ? undefined : [after[0], uuidFromString(after[1])],
          request.direction,
        );
        const rows = yield* sql<InputRow>`
          SELECT ${sql.literal(COLUMNS)} FROM session_inputs
          WHERE session_id = ${uuidFromString(request.sessionId)} AND ${keyset}
          ${order} LIMIT ${request.limit + 1}
        `;
        return yield* pageOf(
          rows,
          request.limit,
          (found) => Effect.succeed(found.map(toInput)),
          (last) => encodeCursor(scope, last.createdAt, last.id),
        );
      }),

    /** What a flush sends next: the oldest row still waiting, if any. */
    oldestWaiting: (sessionId: string): Effect.Effect<Option.Option<StoredInput>, SqlError> =>
      Effect.map(
        sql<InputRow>`
          SELECT ${sql.literal(COLUMNS)} FROM session_inputs
          WHERE session_id = ${uuidFromString(sessionId)} AND status = 'queued' AND sent_at IS NULL
          ORDER BY created_at, id LIMIT 1
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), toInput),
      ),

    /**
     * Marks a row on the wire, the moment before its frame goes out to the
     * machine, and hands back the row as this claim actually found it - never
     * a snapshot taken before it, which a rewrite landing in between could
     * have already changed. `none` when it was already on the wire, already
     * answered, or already called off - the only outcome a second claimant
     * racing the same row can get.
     */
    claim: (id: string, at: string): Effect.Effect<Option.Option<StoredInput>, SqlError> =>
      Effect.map(
        sql<InputRow>`
          UPDATE session_inputs SET sent_at = ${at}, reason = NULL
          WHERE id = ${uuidFromString(id)} AND status = 'queued' AND sent_at IS NULL
          RETURNING ${sql.literal(COLUMNS)}
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), toInput),
      ),

    /**
     * Records what the runner said this input did. Only a row still `queued`
     * moves: a caller may have cancelled it while the frame was in flight.
     */
    delivered: (id: string, delivery: Delivery, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE session_inputs SET status = 'delivered', delivery = ${delivery},
                                  delivered_at = ${at}, sent_at = NULL
        WHERE id = ${uuidFromString(id)} AND status = 'queued'
      `),

    /**
     * Puts a row a delivery could not finish back to waiting, with the reason
     * on it: the next transition to idle or a hand steer tries again, and the
     * reason is what a caller sees until one of them does.
     */
    requeue: (id: string, reason: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE session_inputs SET sent_at = NULL, reason = ${reason}
        WHERE id = ${uuidFromString(id)} AND status = 'queued'
      `),

    rewrite: (id: string, text: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE session_inputs SET text = ${text}
        WHERE id = ${uuidFromString(id)} AND status = 'queued' AND sent_at IS NULL
      `),

    cancel: (id: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE session_inputs SET status = 'cancelled'
        WHERE id = ${uuidFromString(id)} AND status = 'queued' AND sent_at IS NULL
      `),

    /**
     * Ends a row whose session is gone by the time an answer for it arrives:
     * nothing waits on a harness that has exited, and the reason is kept so a
     * caller reading the row's history can see why it never went through.
     */
    cancelWithReason: (id: string, reason: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE session_inputs SET status = 'cancelled', sent_at = NULL, reason = ${reason}
        WHERE id = ${uuidFromString(id)} AND status = 'queued'
      `),

    /**
     * Nothing waits on a harness that is gone. A row on the wire is left
     * alone: the machine has its text, and recording it as called off would
     * be the one thing this store must never say.
     */
    cancelQueued: (sessionId: string, reason?: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE session_inputs SET status = 'cancelled', reason = COALESCE(${reason ?? null}, reason)
        WHERE session_id = ${uuidFromString(sessionId)} AND status = 'queued' AND sent_at IS NULL
      `),

    /**
     * Ends every row a restart caught on the wire: whether the harness took it
     * before the connection dropped is unknown, so it is neither delivered nor
     * resent - resending risks the message reaching the harness twice.
     */
    cancelStranded: (reason: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE session_inputs SET status = 'cancelled', sent_at = NULL, reason = ${reason}
        WHERE status = 'queued' AND sent_at IS NOT NULL
      `),
  };
});

export const inputRepository = make;
