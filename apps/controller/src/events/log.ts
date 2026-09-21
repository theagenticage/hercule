/**
 * The log's rows, and the ways of walking it that are not a public read.
 *
 * `event.query` pages the log for a caller; the live socket follows it from a
 * position; the matcher walks the pipeline events past its cursor. All of them
 * answer with the same `Event`, built here from the same columns, so a record
 * pushed over the socket and the same record fetched over HTTP are the same
 * document field for field.
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

/**
 * The next pipeline events after a position, oldest first, at most `limit` of
 * them.
 *
 * One table holds two populations and only one of them is matched, so the
 * audit entries are left out by the query rather than by the caller: a walk
 * that read them and then dropped them would read a log full of audit entries
 * one batch at a time and make no progress.
 */
export const pipelineEventsAfter = (
  sql: SqlClient.SqlClient,
  after: number,
  limit: number,
): Effect.Effect<ReadonlyArray<Event>, SqlError> =>
  Effect.map(
    sql<EventRow>`
      SELECT ${sql.literal(EVENT_COLUMNS)} FROM events
      WHERE id > ${after} AND kind NOT IN ${sql.in(AUDIT_KINDS)} ORDER BY id LIMIT ${limit}
    `,
    (rows) => rows.map(toEvent),
  );

/**
 * One pipeline event by its position, or none. An audit entry answers none:
 * an entry about what Hercule itself did is not a fact anything waits for.
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
    (rows) => Option.map(Option.fromNullishOr(rows[0]), toEvent),
  );
