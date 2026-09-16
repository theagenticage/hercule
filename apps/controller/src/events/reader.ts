/**
 * The event log, read: `event.query` and `event.read`.
 *
 * One table holds two populations and this reader mostly tells them apart by
 * nothing: a `task.created` row and a `github.issue.opened` row come back from
 * the same unfiltered call, differing only in their `kind`. The log is also the
 * audit log, and the reason to open it is usually to read what happened around
 * something, so there is one grant to read it with.
 *
 * The exception is the security entries - what happened to a secret, a
 * credential or the user's account. A session reads those only if its
 * permission profile holds `event.audit` as well; without it they are not in
 * the page and not readable by id. The user has parity and reads the log whole.
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
import type { Fragment } from "effect/unstable/sql/Statement";
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
import { requireGrant, type Actor } from "../actor";
import { decodeIdCursor, encodeIdCursor, keysetOver, pageOf, uuidFromString } from "../db";
import { SECURITY_KINDS } from "./audit-log";
import { EVENT_COLUMNS, toEvent, type EventRow } from "./log";

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

/**
 * Whether the security entries are hidden from this actor. The user has parity
 * and reads the log whole; anyone else reads them only by holding
 * `event.audit`, so an actor kind added later is withheld from them until someone
 * decides it should not be.
 */
const withoutSecurityEntries = (actor: Actor): boolean =>
  actor._tag !== "user" && !(actor._tag === "session" && actor.grants.includes("event.audit"));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /** One page of the log, newest first unless the caller says otherwise. */
    query: (
      input: QueryInput,
    ): Effect.Effect<EventPage, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("event.query");
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

        const where: Array<Fragment> = [sql`1 = 1`];
        if (decoded.connectionId !== undefined) {
          where.push(sql`connection_id = ${uuidFromString(decoded.connectionId)}`);
        }
        if (decoded.kind !== undefined) where.push(sql`kind = ${decoded.kind}`);
        if (decoded.since !== undefined) where.push(sql`received_at >= ${decoded.since}`);
        if (decoded.until !== undefined) where.push(sql`received_at <= ${decoded.until}`);
        // Hidden in the query rather than dropped from the page that comes
        // back, so a page stays as full as it was asked for and the cursor at
        // its end still points at the next unread row.
        if (withoutSecurityEntries(actor)) {
          where.push(sql`kind NOT IN ${sql.in(SECURITY_KINDS)}`);
        }
        // The log's id is its order, so the walk needs no second column to
        // break a tie on: the id is the whole key.
        const { keyset, order } = keysetOver(
          sql,
          ["id"],
          after === undefined ? undefined : [after],
          direction,
        );
        where.push(keyset);

        const rows = yield* sql<EventRow>`
          SELECT ${sql.literal(EVENT_COLUMNS)} FROM events
          WHERE ${sql.and(where)} ${order} LIMIT ${limit + 1}
        `;
        const page = yield* pageOf(
          rows,
          limit,
          (read) => Effect.succeed(read.map(toEvent)),
          (last) => encodeIdCursor(scope, last.id),
        );
        return {
          items: page.items,
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        };
      }),

    /** One entry by its position in the log. */
    read: (
      input: Identified,
    ): Effect.Effect<Event, Unauthenticated | Forbidden | Validation | NotFound | SqlError> =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("event.read");
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        // An entry this caller may not see answers as an entry that is not
        // there: a hidden row and an id past the head of the log are one
        // answer, so the log's contents cannot be probed by id.
        const hidden = withoutSecurityEntries(actor)
          ? sql`AND kind NOT IN ${sql.in(SECURITY_KINDS)}`
          : sql``;
        const rows = yield* sql<EventRow>`
          SELECT ${sql.literal(EVENT_COLUMNS)} FROM events WHERE id = ${id} ${hidden}
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
