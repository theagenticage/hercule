/**
 * The repository for a session's inputs. Inputs belong to a session, so this
 * lives beside the session repository rather than in a domain of its own.
 *
 * Nothing here decides whether an input is sent or held; the service does.
 * The queue is simply the rows whose status is still `queued`.
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
  buildKeyset,
  mintUuid,
  buildPage,
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
  /** Set while the input has been sent to the runner and not yet answered; null otherwise. */
  readonly sentAt: string | null;
  /** Why a delivery failed, on a row still queued or cancelled because of it; null otherwise. */
  readonly reason: string | null;
}

export interface NewInput {
  readonly sessionId: string;
  readonly source: InputSource;
  readonly actor: string;
  readonly text: string;
  readonly at: string;
  /**
   * Set to claim the row in the same insert, for an input sent to an idle
   * session. No separate claim can lose a race, because nothing else can see
   * the row before this transaction commits.
   */
  readonly sentAt?: string;
}

/** A wake-up that was sent, never acknowledged, and cannot be stored again. */
export interface LostWakeUp {
  readonly subscriptionId: string;
  readonly eventId: number;
}

/** An input created by a subscription match, with the subscription and event it came from. */
export interface NewMatchedInput {
  readonly sessionId: string;
  readonly subscriptionId: string;
  /** The position in the log of the event that matched. */
  readonly eventId: number;
  readonly actor: string;
  readonly text: string;
  readonly at: string;
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
 * Builds the cursor scope for one session's input list. The list is per
 * session, so the session id is part of the scope. Without it, a cursor from
 * one session's list would silently skip rows on another session's list.
 */
const buildCursorScope = (sessionId: string, direction: SortDirection): CursorScope => ({
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

    /**
     * Stores the input created by one match. Returns `none` and writes nothing
     * when the same subscription and event already have a row.
     *
     * An event log consumer that committed its rows but stopped before saving
     * how far it had read will read those events again. So the unique
     * (subscription, event) pair, not the caller, guarantees one input per
     * match. The row is never claimed in the insert: the input is sent to the
     * session only after the write is durable.
     */
    insertMatched: (input: NewMatchedInput): Effect.Effect<Option.Option<StoredInput>, SqlError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        const written = yield* sql<{ readonly id: Uint8Array }>`
          INSERT INTO session_inputs
            (id, session_id, source, actor, text, status, created_at, subscription_id, event_id)
          VALUES (${id}, ${uuidFromString(input.sessionId)}, 'subscription', ${input.actor},
                  ${input.text}, 'queued', ${input.at},
                  ${uuidFromString(input.subscriptionId)}, ${input.eventId})
          ON CONFLICT (subscription_id, event_id) WHERE subscription_id IS NOT NULL
            DO NOTHING
          RETURNING id
        `;
        if (written.length === 0) return Option.none();
        return Option.some({
          id: uuidToString(id),
          sessionId: input.sessionId,
          source: "subscription",
          actor: input.actor,
          text: input.text,
          status: "queued",
          delivery: null,
          createdAt: input.at,
          deliveredAt: null,
          sentAt: null,
          reason: null,
        });
      }),

    /**
     * Cancels every input from one subscription that is still waiting, with
     * the reason the subscription ended. Returns the ids of the sessions whose
     * inputs were cancelled. An input already sent is left alone, for the
     * reason given on `cancelQueued`.
     */
    cancelQueuedForSubscription: (
      subscriptionId: string,
      reason: string,
    ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.map(
        sql<{ readonly session_id: Uint8Array }>`
          UPDATE session_inputs SET status = 'cancelled', reason = ${reason}
          WHERE subscription_id = ${uuidFromString(subscriptionId)}
            AND status = 'queued' AND sent_at IS NULL
          RETURNING session_id
        `,
        (rows) => [...new Set(rows.map((row) => uuidToString(row.session_id)))],
      ),

    /**
     * Returns the ids of the sessions that have a queued input not yet sent,
     * whoever created it. The rows record what still has to be sent, so
     * nothing needs to be remembered across a restart. The next caller picks
     * up both of these:
     *
     * - a row the controller stopped on between the commit and the send;
     * - a row whose session went idle without the controller noticing.
     *
     * This holds for a person's typed input as well as for a match's.
     *
     * A session that already has an input sent and unanswered is left out.
     * The runner takes one input per turn boundary, so a second input sent
     * before the first one's turn has started would have to be held by the
     * runner.
     */
    listSessionsAwaitingInput: (): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.map(
        sql<{ readonly session_id: Uint8Array }>`
          SELECT DISTINCT waiting.session_id FROM session_inputs AS waiting
          WHERE waiting.status = 'queued' AND waiting.sent_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM session_inputs AS onTheWire
              WHERE onTheWire.session_id = waiting.session_id
                AND onTheWire.status = 'queued' AND onTheWire.sent_at IS NOT NULL
            )
        `,
        (rows) => rows.map((row) => uuidToString(row.session_id)),
      ),

    /**
     * Checks whether this session has an input that was sent and not yet
     * answered.
     *
     * The runner takes one input per turn boundary. A second input sent before
     * the first one's turn has started would have to be held by the runner, so
     * a caller with an input still out sends nothing more until the runner
     * reports what happened to it.
     */
    holdsInputOnTheWire: (sessionId: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          SELECT id FROM session_inputs
          WHERE session_id = ${uuidFromString(sessionId)}
            AND status = 'queued' AND sent_at IS NOT NULL
          LIMIT 1
        `,
        (rows) => rows.length > 0,
      ),

    /** Returns one input of a session. An input id that belongs to another session returns `none`. */
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
        const scope = buildCursorScope(request.sessionId, request.direction);
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeCursor(request.cursor, scope, "string");
        const { keyset, order } = buildKeyset(
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
        return yield* buildPage(
          rows,
          request.limit,
          (found) => Effect.succeed(found.map(toInput)),
          (last) => encodeCursor(scope, last.createdAt, last.id),
        );
      }),

    /** Returns the oldest input still waiting to be sent, which is the next one a flush sends. */
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
     * Marks an input as sent, just before its frame goes out to the runner.
     * Returns the row as the update found it, not a copy read earlier, which
     * an edit in between could have changed. Returns `none` when the input was
     * already sent, already answered, or already cancelled. A second caller
     * racing to claim the same input always gets `none`.
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
     * Records the delivery the runner reported for this input. Only a row
     * still `queued` changes, because a caller may have cancelled it while the
     * frame was in flight.
     */
    delivered: (id: string, delivery: Delivery, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE session_inputs SET status = 'delivered', delivery = ${delivery},
                                  delivered_at = ${at}, sent_at = NULL
        WHERE id = ${uuidFromString(id)} AND status = 'queued'
      `),

    /**
     * Puts an input whose delivery failed back to waiting, and stores the
     * reason. The next time the session goes idle, or a user steers by hand,
     * the input is sent again. Until then, a caller sees the reason.
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
     * Cancels an input whose session exited before the runner answered for it.
     * Nothing waits on a harness that has exited. The reason is stored so a
     * caller reading the input later can see why it was never delivered.
     */
    cancelWithReason: (id: string, reason: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE session_inputs SET status = 'cancelled', sent_at = NULL, reason = ${reason}
        WHERE id = ${uuidFromString(id)} AND status = 'queued'
      `),

    /**
     * Cancels every input of a session that is still waiting, because nothing
     * waits on a harness that has exited. An input already sent is left alone:
     * the runner has its text, so recording it as cancelled would be wrong.
     */
    cancelQueued: (sessionId: string, reason?: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE session_inputs SET status = 'cancelled', reason = COALESCE(${reason ?? null}, reason)
        WHERE session_id = ${uuidFromString(sessionId)} AND status = 'queued' AND sent_at IS NULL
      `),

    /**
     * Cancels every input that was sent but unanswered when the controller
     * restarted. Nobody knows whether the harness received it before the
     * connection dropped, so it is neither marked delivered nor sent again:
     * sending it again could deliver the message twice.
     *
     * Returns the wake-ups lost with those inputs. An input created by a match
     * stores the subscription and event it came from, and that pair can never
     * be stored again, so the caller needs to know which subscription lost a
     * wake-up.
     */
    cancelStranded: (reason: string): Effect.Effect<ReadonlyArray<LostWakeUp>, SqlError> =>
      Effect.map(
        sql<{
          readonly subscription_id: Uint8Array | null;
          readonly event_id: number | null;
        }>`
          UPDATE session_inputs SET status = 'cancelled', sent_at = NULL, reason = ${reason}
          WHERE status = 'queued' AND sent_at IS NOT NULL
          RETURNING subscription_id, event_id
        `,
        (rows) =>
          rows.flatMap((row) =>
            row.subscription_id === null || row.event_id === null
              ? []
              : [{ subscriptionId: uuidToString(row.subscription_id), eventId: row.event_id }],
          ),
      ),
  };
});

export const inputRepository = make;
