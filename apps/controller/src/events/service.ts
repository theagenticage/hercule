/**
 * The event log's own operations: `event.query` and `event.read`, which read
 * it, `event.emit`, which appends one manual event to it, and `amend`, which
 * rewrites what one of those manual events is about for the enrichment use
 * case above this domain.
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
 * Audit entries are not written here. The audit writer appends those, one row
 * per mutation, inside that mutation's transaction.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Fragment } from "effect/unstable/sql/Statement";
import {
  bounded,
  DEFAULT_PAGE_LIMIT,
  EventEmitInput,
  EVENT_SORT_FIELDS,
  EventId,
  Id,
  MAX_EVENT_KIND_LENGTH,
  MAX_PAGE_LIMIT,
  listDecodeIssues,
  createNotFoundError,
  SortDirection,
  Timestamp,
  createValidationError,
  createDecodeValidationError,
  type EventEmitted,
  type Event,
  type Forbidden,
  type NotFound,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { currentStamp, requireGrant, type Actor } from "../actor";
import {
  announce,
  decodeIdCursor,
  encodeIdCursor,
  keysetOver,
  nowIso,
  pageOf,
  uuidFromString,
  withTransaction,
} from "../db";
import { AUDIT_KINDS, SECURITY_KINDS } from "./audit-log";
import { EventKindCatalog } from "./catalog";
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
const decodeEmit = Schema.decodeUnknownEffect(EventEmitInput, { errors: "all" });
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

/**
 * A payload read against the schema its kind declared. Every issue is reported
 * at once, so a caller fixes the whole payload in one retry, and a key the
 * schema does not name is refused rather than dropped: the JSON Schema the
 * catalog publishes says no other key is allowed, and a payload stored with a
 * key the schema turned down would make that published shape a lie. A kind
 * grows by its plugin widening the schema, and the catalog is rewritten at
 * every boot.
 */
const decodeAgainstKind = (
  schema: Schema.Top,
  payload: unknown,
): Effect.Effect<unknown, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(schema as Schema.Codec<unknown>, {
    errors: "all",
    onExcessProperty: "error",
  })(payload);

/**
 * What the payload's own issues read as on the request. They are rooted under
 * the field they came from, so an issue about a payload key can never be read
 * as one about `kind` or `refs`.
 */
const refusePayload = (error: Schema.SchemaError): Validation =>
  createValidationError(
    listDecodeIssues(error).map((issue) => ({ ...issue, path: ["payload", ...issue.path] })),
  );

/**
 * The external system an event of this kind is about: the id of the plugin
 * that declared the kind. Every kind name begins with its plugin's id and a
 * dot, which the plugin host refuses a registration without, so the prefix is
 * the owner and nothing has to be looked up a second time.
 */
const readSystemFromKind = (kind: string): string => kind.slice(0, kind.indexOf("."));

/** The audit kinds, as one lookup: the population enrichment may not touch. */
const AUDIT_KIND_NAMES: ReadonlySet<string> = new Set(AUDIT_KINDS);

/** The refs an event held and the refs being added, each one once, oldest first. */
const mergeRefs = (
  held: ReadonlyArray<string>,
  added: ReadonlyArray<string>,
): ReadonlyArray<string> => [...new Set([...held, ...added])];

/** What enrichment may amend on one event, already decoded. */
interface Amendment {
  readonly id: number;
  readonly system?: string;
  readonly url?: string;
  readonly refs?: ReadonlyArray<string>;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const catalog = yield* EventKindCatalog;

  return {
    /** One page of the log, newest first unless the caller says otherwise. */
    query: (
      input: QueryInput,
    ): Effect.Effect<EventPage, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("event.query");
        const decoded = yield* Effect.mapError(decodeQuery(input), createDecodeValidationError);
        const direction = decoded.sort?.direction ?? DEFAULT_DIRECTION;
        const limit = decoded.limit ?? DEFAULT_PAGE_LIMIT;
        const scope = { op: "event.query", field: "id", direction } as const;

        const after =
          decoded.cursor === undefined
            ? undefined
            : yield* decodeIdCursor(decoded.cursor, scope).pipe(
                Effect.catchTag("CursorError", (error) =>
                  Effect.fail(
                    createValidationError([{ path: ["cursor"], message: error.message }]),
                  ),
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
        const { id } = yield* Effect.mapError(decodeIdentified(input), createDecodeValidationError);
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
        return row === undefined
          ? yield* Effect.fail(createNotFoundError("no such event"))
          : toEvent(row);
      }),

    /**
     * Appends one synthetic event. The caller says what happened and what it is
     * about; the core says where it came from, who posted it and when, so
     * nothing a caller can write makes a manual event look ingested.
     */
    emit: (
      input: EventEmitInput,
    ): Effect.Effect<
      EventEmitted,
      Unauthenticated | Forbidden | Validation | NotFound | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireGrant("event.emit");
        const decoded = yield* Effect.mapError(decodeEmit(input), createDecodeValidationError);

        // A kind nobody declared has no schema to read the payload against, so
        // there is nothing to write.
        const payloadSchema = yield* Effect.flatMap(
          catalog.readPayloadSchema(decoded.kind),
          Option.match({
            onNone: () =>
              Effect.fail(
                createValidationError([
                  { path: ["kind"], message: `no plugin declares the event kind ${decoded.kind}` },
                ]),
              ),
            onSome: Effect.succeed,
          }),
        );
        yield* Effect.mapError(decodeAgainstKind(payloadSchema, decoded.payload), refusePayload);

        const actor = yield* currentStamp;
        const at = yield* nowIso;
        // One post is one moment, so the instant it happened and the instant
        // the log took it are the same read of the clock.
        const connectionId =
          decoded.connectionId === undefined ? null : uuidFromString(decoded.connectionId);
        // Without a key of the caller's own, every post is its own fact: two
        // identical posts are two things that happened, not one repeated.
        const dedupKey = decoded.dedupKey ?? crypto.randomUUID();
        // Each ref once, as `amend` stores them: a caller that wrote one twice
        // meant one identity, and the stored list is what a later reader
        // compares against.
        const refs = JSON.stringify([...new Set(decoded.refs ?? [])]);

        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            // The Connection an event is stamped with is what every later
            // reader follows back to the account it came through, so an id
            // naming no row is refused rather than written. The connections
            // domain appends audit entries to this log and so depends on it;
            // the row is read sideways here instead of through that domain,
            // which would close the cycle.
            if (connectionId !== null) {
              const known = yield* sql<{ readonly id: Uint8Array }>`
                SELECT id FROM connections WHERE id = ${connectionId}
              `;
              if (known.length === 0) {
                return yield* Effect.fail(
                  createNotFoundError(`no connection has the id ${decoded.connectionId!}`),
                );
              }
            }
            const written = yield* sql<{ readonly id: number }>`
              INSERT INTO events
                (source, connection_id, system, kind, occurred_at, received_at,
                 dedup_key, refs, url, payload, raw, actor)
              VALUES
                ('manual', ${connectionId}, ${readSystemFromKind(decoded.kind)}, ${decoded.kind}, ${at}, ${at},
                 ${dedupKey}, ${refs}, NULL, ${JSON.stringify(decoded.payload)}, NULL, ${actor})
              ON CONFLICT (ifnull(connection_id, x''), dedup_key) DO NOTHING
              RETURNING id
            `;
            const appended = written[0];
            if (appended === undefined) {
              // The unique index turned the insert away, which means this
              // caller has posted this key through this Connection before. The
              // event it wrote then is the answer.
              const existing = yield* sql<{ readonly id: number }>`
                SELECT id FROM events
                WHERE ifnull(connection_id, x'') = ifnull(${connectionId}, x'')
                  AND dedup_key = ${dedupKey}
              `;
              return { eventId: existing[0]!.id };
            }
            // The log is a Live Topic of its own, so a row appended to it is
            // news the log grew.
            yield* announce({ _tag: "event" });
            return { eventId: appended.id };
          }),
        );
      }),

    /**
     * Amends what one event is about. What is named is overwritten and what is
     * left out stays as it was; refs are only added to, so nothing that has
     * already matched on a ref can stop matching on it.
     *
     * Only a pipeline event can be amended. An audit entry is the log's other
     * population: it is the record of a mutation, nothing may rewrite it, and
     * an id naming one answers exactly as an id naming nothing does, so the
     * log's contents cannot be probed through this operation either.
     *
     * The caller opens the transaction, because the read and the write have to
     * be one and the caller has more to put inside it.
     */
    amend: (input: Amendment): Effect.Effect<Event, NotFound | SqlError> =>
      Effect.gen(function* () {
        const rows = yield* sql<EventRow>`
          SELECT ${sql.literal(EVENT_COLUMNS)} FROM events WHERE id = ${input.id}
        `;
        const row = rows[0];
        if (row === undefined || AUDIT_KIND_NAMES.has(row.kind)) {
          return yield* Effect.fail(createNotFoundError("no such event"));
        }
        const held = toEvent(row);

        const system = input.system ?? held.system;
        const url = input.url ?? held.url;
        const refs = mergeRefs(held.refs, input.refs ?? []);

        yield* sql`
          UPDATE events
          SET system = ${system}, url = ${url}, refs = ${JSON.stringify(refs)}
          WHERE id = ${input.id}
        `;
        // Nothing is announced: the live `event` topic is append-only, so an
        // amended event is not news the log grew, and a live view goes on
        // showing the old system, url and refs until it is loaded again.
        return { ...held, system, url, refs };
      }),
  };
});

/** The event log's reader. */
export class EventService extends Context.Service<EventService, Effect.Success<typeof make>>()(
  "hercule/controller/events/EventService",
) {}

export const EventServiceLayer: Layer.Layer<
  EventService,
  never,
  SqlClient.SqlClient | EventKindCatalog
> = Layer.effect(EventService)(make);
