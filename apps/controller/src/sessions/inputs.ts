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
import type { Delivery, ModelSelection } from "@hydra/protocol";
import type { InputSource, InputStatus, SortDirection } from "@hydra/contract";
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
  readonly modelSelection: ModelSelection | null;
  readonly status: InputStatus;
  readonly delivery: Delivery | null;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
}

export interface NewInput {
  readonly sessionId: string;
  readonly source: InputSource;
  readonly actor: string;
  readonly text: string;
  readonly modelSelection: ModelSelection | undefined;
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
  readonly model_selection: string | null;
  readonly status: string;
  readonly delivery: string | null;
  readonly created_at: string;
  readonly delivered_at: string | null;
}

const COLUMNS =
  "id, session_id, source, actor, text, model_selection, status, delivery, " +
  "created_at, delivered_at";

const toInput = (row: InputRow): StoredInput => ({
  id: uuidToString(row.id),
  sessionId: uuidToString(row.session_id),
  source: row.source as InputSource,
  actor: row.actor,
  text: row.text,
  modelSelection:
    row.model_selection === null ? null : (JSON.parse(row.model_selection) as ModelSelection),
  status: row.status as InputStatus,
  delivery: row.delivery as Delivery | null,
  createdAt: row.created_at,
  deliveredAt: row.delivered_at,
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
        const modelSelection =
          input.modelSelection === undefined ? null : JSON.stringify(input.modelSelection);
        yield* sql`
          INSERT INTO session_inputs (id, session_id, source, actor, text, model_selection,
                                      status, created_at)
          VALUES (${id}, ${uuidFromString(input.sessionId)}, ${input.source}, ${input.actor},
                  ${input.text}, ${modelSelection}, 'queued', ${input.at})
        `;
        return {
          id: uuidToString(id),
          sessionId: input.sessionId,
          source: input.source,
          actor: input.actor,
          text: input.text,
          modelSelection: input.modelSelection ?? null,
          status: "queued",
          delivery: null,
          createdAt: input.at,
          deliveredAt: null,
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

    /** What a flush sends: everything still waiting on this session, oldest first. */
    queued: (sessionId: string): Effect.Effect<ReadonlyArray<StoredInput>, SqlError> =>
      Effect.map(
        sql<InputRow>`
          SELECT ${sql.literal(COLUMNS)} FROM session_inputs
          WHERE session_id = ${uuidFromString(sessionId)} AND status = 'queued'
          ORDER BY created_at, id
        `,
        (rows) => rows.map(toInput),
      ),

    /**
     * Records what the runner said this input did. Only a row still `queued`
     * moves: a caller may have cancelled it while the frame was in flight.
     */
    delivered: (id: string, delivery: Delivery, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE session_inputs SET status = 'delivered', delivery = ${delivery},
                                  delivered_at = ${at}
        WHERE id = ${uuidFromString(id)} AND status = 'queued'
      `),

    retext: (id: string, text: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE session_inputs SET text = ${text}
        WHERE id = ${uuidFromString(id)} AND status = 'queued'
      `),

    cancel: (id: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE session_inputs SET status = 'cancelled'
        WHERE id = ${uuidFromString(id)} AND status = 'queued'
      `),

    /**
     * Nothing waits on a harness that is gone. An input already on the wire is
     * left alone: the machine has its text, and recording it as called off
     * would be the one thing this store must never say.
     */
    cancelQueued: (
      sessionId: string,
      onTheWire: ReadonlySet<string>,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE session_inputs SET status = 'cancelled'
        WHERE session_id = ${uuidFromString(sessionId)} AND status = 'queued'
          AND id NOT IN ${sql.in([...onTheWire].map(uuidFromString))}
      `),
  };
});

export const inputRepository = make;
