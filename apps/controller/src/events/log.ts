/**
 * The log's rows, and the internal reads of the log.
 *
 * `event.query` pages through the log for a caller; the live socket follows it
 * from a position; the event router reads the pipeline events after its
 * cursor. All of them return the same `Event`, built here from the same
 * columns, so a record pushed over the socket and the same record fetched over
 * HTTP are identical, field for field.
 *
 * The position a durable consumer has read to is kept here too, because it is
 * a position in this log. A consumer that wrote its own query would be a
 * second reader of the events table outside the domain that owns it.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Event } from "@hercule/contract";
import { uuidToString } from "../db";
import { AUDIT_KINDS } from "./audit-log";

export const EVENT_COLUMNS =
  "id, source, connection_id, system, kind, occurred_at, received_at, " +
  "dedup_key, refs, url, payload, raw, actor";

export interface EventRow {
  readonly id: number;
  readonly source: string;
  readonly connection_id: Uint8Array | null;
  readonly system: string;
  readonly kind: string;
  readonly occurred_at: string;
  readonly received_at: string;
  readonly dedup_key: string;
  readonly refs: string;
  readonly url: string | null;
  readonly payload: string;
  readonly raw: string | null;
  readonly actor: string | null;
}

const parseJsonObject = (text: string): Record<string, unknown> =>
  JSON.parse(text) as Record<string, unknown>;

/** Parses one row of the events table into the event the API returns. */
export const parseEventRow = (row: EventRow): Event => ({
  id: row.id,
  source: row.source,
  connectionId: row.connection_id === null ? null : uuidToString(row.connection_id),
  system: row.system,
  kind: row.kind,
  occurredAt: row.occurred_at,
  receivedAt: row.received_at,
  dedupKey: row.dedup_key,
  refs: JSON.parse(row.refs) as ReadonlyArray<string>,
  url: row.url,
  payload: parseJsonObject(row.payload),
  raw: row.raw === null ? null : parseJsonObject(row.raw),
  actor: row.actor,
});

/** Returns the position of the newest entry, or zero if the log is empty. */
export const readLogHead = (sql: SqlClient.SqlClient): Effect.Effect<number, SqlError> =>
  Effect.map(
    sql<{ readonly head: number | null }>`SELECT MAX(id) AS head FROM events`,
    (rows) => rows[0]?.head ?? 0,
  );

/** Returns at most `limit` entries after a position, oldest first. */
export const readEventsAfter = (
  sql: SqlClient.SqlClient,
  after: number,
  limit: number,
): Effect.Effect<ReadonlyArray<Event>, SqlError> =>
  Effect.map(
    sql<EventRow>`
      SELECT ${sql.literal(EVENT_COLUMNS)} FROM events
      WHERE id > ${after} ORDER BY id LIMIT ${limit}
    `,
    (rows) => rows.map(parseEventRow),
  );

/**
 * Returns at most `limit` pipeline events after a position, oldest first.
 *
 * One table holds both pipeline events and audit entries, and only pipeline
 * events are matched. So the query leaves out the audit entries, not the
 * caller. A caller that read them and then dropped them could read a batch
 * made only of audit entries, and on a log full of them it would make almost
 * no progress per batch.
 */
export const readPipelineEventsAfter = (
  sql: SqlClient.SqlClient,
  after: number,
  limit: number,
): Effect.Effect<ReadonlyArray<Event>, SqlError> =>
  Effect.map(
    sql<EventRow>`
      SELECT ${sql.literal(EVENT_COLUMNS)} FROM events
      WHERE id > ${after} AND kind NOT IN ${sql.in(AUDIT_KINDS)} ORDER BY id LIMIT ${limit}
    `,
    (rows) => rows.map(parseEventRow),
  );

/**
 * Returns the pipeline event at a position, or none. Returns none for an audit
 * entry too, because an audit entry is never routed.
 */
export const readPipelineEvent = (
  sql: SqlClient.SqlClient,
  id: number,
): Effect.Effect<Option.Option<Event>, SqlError> =>
  Effect.map(
    sql<EventRow>`
      SELECT ${sql.literal(EVENT_COLUMNS)} FROM events
      WHERE id = ${id} AND kind NOT IN ${sql.in(AUDIT_KINDS)}
    `,
    (rows) => Option.map(Option.fromNullishOr(rows[0]), parseEventRow),
  );

/**
 * Returns the position this consumer has read to. The first time a consumer
 * calls this, it creates the consumer's cursor at position zero. Ids start at
 * one, so a new consumer reads everything in the log.
 *
 * The row is written only when it is missing, not on every read: a consumer
 * reads its position on every pass, and an upsert would add a write to every
 * pass.
 */
export const readConsumerPosition = (
  sql: SqlClient.SqlClient,
  consumer: string,
): Effect.Effect<number, SqlError> =>
  Effect.gen(function* () {
    const held = yield* sql<{
      readonly position: number;
    }>`SELECT position FROM event_cursors WHERE consumer = ${consumer}`;
    if (held[0] !== undefined) return held[0].position;
    yield* sql`INSERT INTO event_cursors (consumer, position) VALUES (${consumer}, 0)`;
    return 0;
  });

/** Records that this consumer has finished with everything up to this position. */
export const advanceConsumerCursor = (
  sql: SqlClient.SqlClient,
  consumer: string,
  position: number,
): Effect.Effect<void, SqlError> =>
  Effect.asVoid(sql`UPDATE event_cursors SET position = ${position} WHERE consumer = ${consumer}`);
