/**
 * The log's rows, and the two ways of walking it that are not a public read.
 *
 * `event.query` pages the log for a caller; the live socket follows it from a
 * position. Both answer with the same `Event`, built here from the same columns,
 * so a record pushed over the socket and the same record fetched over HTTP are
 * the same document field for field.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Event } from "@hercule/contract";
import { uuidToString } from "../db";

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

const object = (text: string): Record<string, unknown> =>
  JSON.parse(text) as Record<string, unknown>;

export const toEvent = (row: EventRow): Event => ({
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
  payload: object(row.payload),
  raw: row.raw === null ? null : object(row.raw),
  actor: row.actor,
});

/** The position of the newest entry, or zero for a log nothing has written to. */
export const headOfLog = (sql: SqlClient.SqlClient): Effect.Effect<number, SqlError> =>
  Effect.map(
    sql<{ readonly head: number | null }>`SELECT MAX(id) AS head FROM events`,
    (rows) => rows[0]?.head ?? 0,
  );

/** The next entries after a position, oldest first, at most `limit` of them. */
export const eventsAfter = (
  sql: SqlClient.SqlClient,
  after: number,
  limit: number,
): Effect.Effect<ReadonlyArray<Event>, SqlError> =>
  Effect.map(
    sql<EventRow>`
      SELECT ${sql.literal(EVENT_COLUMNS)} FROM events
      WHERE id > ${after} ORDER BY id LIMIT ${limit}
    `,
    (rows) => rows.map(toEvent),
  );
