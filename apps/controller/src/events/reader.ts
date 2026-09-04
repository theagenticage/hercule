/**
 * The event log, read: `event.query` and `event.read`.
 *
 * One table holds two populations and this reader tells them apart by nothing:
 * a `task.created` row and an `auth.login.failed` row come back from the same
 * unfiltered call, differing only in their `kind`. The log is also the audit
 * log, and the reason to open it is usually to read a security entry beside
 * whatever happened around it, so there is one grant and no population filter.
 *
 * The walk is a keyset over the id, which is the log's position and its only
 * sortable field. `since` and `until` bound `received_at`: that is the log's
 * own axis, the one the id runs monotonically with, so a time window and the
 * order the page comes back in never disagree.
 *
 * Nothing here writes. The audit writer does the appending, one row per
 * mutation, inside that mutation's transaction.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  bounded,
  DEFAULT_PAGE_LIMIT,
  EVENT_SORT_FIELDS,
  EventId,
  Id,
  MAX_EVENT_KIND_LENGTH,
  MAX_PAGE_LIMIT,
  notFound,
  SortDirection,
  Timestamp,
  validation,
  validationOf,
  type Event,
  type Forbidden,
  type NotFound,
  type Unauthenticated,
  type Validation,
} from "@hydra/contract";
import { requireGrant } from "../actor";
import { decodeIdCursor, encodeIdCursor, uuidFromString, uuidToString } from "../db";

/** What narrows and pages a reading of the log. */
const QueryInput = Schema.Struct({
  connectionId: Schema.optionalKey(Id),
  kind: Schema.optionalKey(bounded(1, MAX_EVENT_KIND_LENGTH)),
  since: Schema.optionalKey(Timestamp),
  until: Schema.optionalKey(Timestamp),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_PAGE_LIMIT })),
  ),
  cursor: Schema.optionalKey(Schema.NonEmptyString),
  sort: Schema.optionalKey(
    Schema.Struct({
      field: Schema.Literals(EVENT_SORT_FIELDS),
      direction: Schema.optionalKey(SortDirection),
    }),
  ),
});

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

const Identified = Schema.Struct({ id: EventId });

export type Identified = Schema.Schema.Type<typeof Identified>;

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeIdentified = Schema.decodeUnknownEffect(Identified);

/** One page of the log, in the contract's shape. */
export interface EventPage {
  readonly items: ReadonlyArray<Event>;
  readonly nextCursor?: string;
}

/** Newest first: the log is read from its head. */
const DEFAULT_DIRECTION: SortDirection = "desc";

const COLUMNS =
  "id, source, connection_id, system, kind, occurred_at, received_at, " +
  "dedup_key, refs, url, payload, raw, actor";

interface EventRow {
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

const toEvent = (row: EventRow): Event => ({
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

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /** One page of the log, newest first unless the caller says otherwise. */
    query: (
      input: QueryInput,
    ): Effect.Effect<EventPage, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("event.query");
        const decoded = yield* Effect.mapError(decodeQuery(input), validationOf);
        const direction = decoded.sort?.direction ?? DEFAULT_DIRECTION;
        const limit = decoded.limit ?? DEFAULT_PAGE_LIMIT;
        const scope = { op: "event.query", field: "id", direction } as const;

        const after =
          decoded.cursor === undefined
            ? undefined
            : yield* decodeIdCursor(decoded.cursor, scope).pipe(
                Effect.catchTag("CursorError", (error) =>
                  Effect.fail(validation([{ path: ["cursor"], message: error.message }])),
                ),
              );

        const ascending = direction === "asc";
        const where = [sql`1 = 1`];
        if (decoded.connectionId !== undefined) {
          where.push(sql`connection_id = ${uuidFromString(decoded.connectionId)}`);
        }
        if (decoded.kind !== undefined) where.push(sql`kind = ${decoded.kind}`);
        if (decoded.since !== undefined) where.push(sql`received_at >= ${decoded.since}`);
        if (decoded.until !== undefined) where.push(sql`received_at <= ${decoded.until}`);
        if (after !== undefined) {
          where.push(ascending ? sql`id > ${after}` : sql`id < ${after}`);
        }

        // One row more than asked for: whether it came back is whether there is
        // a next page, which is why no count query is needed to know.
        const rows = yield* sql<EventRow>`
          SELECT ${sql.literal(COLUMNS)} FROM events
          WHERE ${sql.and(where)}
          ORDER BY id ${ascending ? sql`ASC` : sql`DESC`}
          LIMIT ${limit + 1}
        `;
        const items = rows.slice(0, limit).map(toEvent);
        const last = items[items.length - 1];
        return {
          items,
          ...(rows.length > limit && last !== undefined
            ? { nextCursor: encodeIdCursor(scope, last.id) }
            : {}),
        };
      }),

    /** One entry by its position in the log. */
    read: (
      input: Identified,
    ): Effect.Effect<Event, Unauthenticated | Forbidden | Validation | NotFound | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("event.read");
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        const rows = yield* sql<EventRow>`
          SELECT ${sql.literal(COLUMNS)} FROM events WHERE id = ${id}
        `;
        const row = rows[0];
        return row === undefined ? yield* Effect.fail(notFound("no such event")) : toEvent(row);
      }),
  };
});

/** The event log's reader. */
export class EventService extends Context.Service<EventService, Effect.Success<typeof make>>()(
  "hydra/controller/events/EventService",
) {}

export const EventServiceLayer: Layer.Layer<EventService, never, SqlClient.SqlClient> =
  Layer.effect(EventService)(make);
