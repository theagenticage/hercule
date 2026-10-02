/**
 * The event log's own operations: `event.query` and `event.read`, which read
 * it, `event.emit`, which appends one manual event to it, and `amend`, which
 * rewrites what one pipeline event is about, for the enrichment use case in
 * the controller daemon.
 *
 * One table holds both pipeline events and audit entries, and this reader
 * mostly treats them the same: a `task.deleted` row and a `github.issue.opened`
 * row come back from the same unfiltered call, and differ only in their `kind`.
 * The log is also the audit log, and people usually open it to see what
 * happened around something, so one grant reads both.
 *
 * The exception is the security entries - what happened to a secret, a
 * credential or the user's account. A session reads those only if its
 * permission profile holds `event.audit` as well; without it they are not in
 * the page and not readable by id. The user has parity and reads the whole log.
 *
 * Paging uses a keyset over the id, which is the log's position and its only
 * sortable field. `since` and `until` filter on `received_at`, which increases
 * with the id, so a time window never conflicts with the order of the page.
 *
 * Audit entries, platform events and the Scheduler's ticks are not written
 * here. Their writers append them, one row per change, inside that change's
 * transaction.
 *
 * A method that takes only an id does not decode it again: the transport has
 * already decoded a request's id against the contract, and a caller inside
 * the controller passes an id it read from a stored row.
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
  type EventId,
  Id,
  MAX_EVENT_KIND_LENGTH,
  listDecodeIssues,
  createNotFoundError,
  type SortDirection,
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
  decodeIntegerKeyCursor,
  encodeIntegerKeyCursor,
  buildKeyset,
  nowIso,
  buildPage,
  buildPageInputFields,
  resolveSortDirection,
  uuidFromString,
  withTransaction,
} from "../db";
import { appendEvent } from "./append";
import { SECURITY_KINDS } from "./audit-log";
import { EventKindCatalog } from "./catalog";
import { EVENT_COLUMNS, parseEventRow, type EventRow } from "./log";
import { isControllerSource, MANUAL_SOURCE } from "./sources";

/** The filters and paging options of `event.query`. */
const QueryInput = Schema.Struct({
  connectionId: Schema.optionalKey(Id),
  kind: Schema.optionalKey(bounded(1, MAX_EVENT_KIND_LENGTH)),
  since: Schema.optionalKey(Timestamp),
  until: Schema.optionalKey(Timestamp),
  ...buildPageInputFields(EVENT_SORT_FIELDS),
});

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeEmit = Schema.decodeUnknownEffect(EventEmitInput, { errors: "all" });

/** One page of the log, in the contract's shape. */
export interface EventPage {
  readonly items: ReadonlyArray<Event>;
  readonly nextCursor?: string;
}

/** Newest first: the log is read from its head. */
const DEFAULT_DIRECTION: SortDirection = "desc";

/**
 * Returns true if the security entries are hidden from this actor. The user
 * has parity and reads the whole log. Any other actor reads them only if it
 * holds `event.audit`, so an actor kind added later cannot read them until
 * someone decides it should.
 */
const shouldHideSecurityEntries = (actor: Actor): boolean =>
  actor._tag !== "user" && !(actor._tag === "session" && actor.grants.includes("event.audit"));

/**
 * Decodes a payload against the schema its kind declared. Fails with a
 * `SchemaError` that lists every issue at once, so a caller can fix the whole
 * payload in one retry.
 *
 * A key the schema does not name is rejected rather than dropped. The JSON
 * Schema the catalog publishes allows no other keys, so storing a payload with
 * such a key would make the published schema wrong. A plugin adds a key by
 * widening its schema, and the catalog is rewritten at every boot.
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
 * Converts the payload's schema errors into a `Validation` error. Each issue's
 * path starts with `payload`, so an issue about a payload key can never be
 * mistaken for one about `kind` or `refs`.
 */
const createPayloadValidationError = (error: Schema.SchemaError): Validation =>
  createValidationError(
    listDecodeIssues(error).map((issue) => ({ ...issue, path: ["payload", ...issue.path] })),
  );

/**
 * Returns the external system an event of this kind is about: the id of the
 * plugin that declared the kind. Every kind name starts with its plugin's id
 * and a dot, and the plugin host rejects a registration without that prefix.
 * So the prefix names the plugin, and no second lookup is needed.
 */
const readSystemFromKind = (kind: string): string => kind.slice(0, kind.indexOf("."));

/** Returns the event's refs followed by the added refs, with each ref once. */
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
    /**
     * Returns one page of the log, newest first unless the caller sends a sort
     * key. A key with no direction sorts oldest first. Fails with `Validation`
     * for invalid input or a cursor from another listing.
     */
    query: (
      input: QueryInput,
    ): Effect.Effect<EventPage, Unauthenticated | Forbidden | Validation | SqlError> =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("event.query");
        const decoded = yield* Effect.mapError(decodeQuery(input), createDecodeValidationError);
        const direction = resolveSortDirection(decoded.sort, DEFAULT_DIRECTION);
        const limit = decoded.limit ?? DEFAULT_PAGE_LIMIT;
        const scope = { op: "event.query", sort: [{ field: "id", direction }] } as const;

        const after =
          decoded.cursor === undefined
            ? undefined
            : yield* decodeIntegerKeyCursor(decoded.cursor, scope).pipe(
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
        // Filtered in the query rather than dropped from the returned page, so
        // the page is as full as requested and the cursor at its end still
        // points at the next unread row.
        if (shouldHideSecurityEntries(actor)) {
          where.push(sql`kind NOT IN ${sql.in(SECURITY_KINDS)}`);
        }
        // The log's id is its order, so paging needs no second column to break
        // a tie: the id is the whole key.
        const { keyset, order } = buildKeyset(
          sql,
          [{ column: "id", direction }],
          [],
          after === undefined ? undefined : [after],
        );
        where.push(keyset);

        const rows = yield* sql<EventRow>`
          SELECT ${sql.literal(EVENT_COLUMNS)} FROM events
          WHERE ${sql.and(where)} ${order} LIMIT ${limit + 1}
        `;
        const page = yield* buildPage(
          rows,
          limit,
          (read) => Effect.succeed(read.map(parseEventRow)),
          (last) => encodeIntegerKeyCursor(scope, last.id),
        );
        return {
          items: page.items,
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        };
      }),

    /**
     * Returns one entry by its position in the log. Fails with `NotFound` if
     * there is no such entry, or if the caller may not see it.
     */
    read: (id: EventId): Effect.Effect<Event, Unauthenticated | Forbidden | NotFound | SqlError> =>
      Effect.gen(function* () {
        const actor = yield* requireGrant("event.read");
        // An entry this caller may not see fails as if it did not exist: a
        // hidden row and an id past the head of the log get the same error, so
        // the log's contents cannot be probed by id.
        const hidden = shouldHideSecurityEntries(actor)
          ? sql`AND kind NOT IN ${sql.in(SECURITY_KINDS)}`
          : sql``;
        const rows = yield* sql<EventRow>`
          SELECT ${sql.literal(EVENT_COLUMNS)} FROM events WHERE id = ${id} ${hidden}
        `;
        const row = rows[0];
        return row === undefined
          ? yield* Effect.fail(createNotFoundError("no such event"))
          : parseEventRow(row);
      }),

    /**
     * Appends one manual event and returns its id. The caller gives what
     * happened and what it is about. The controller sets where it came from,
     * who posted it and when, so a caller cannot make a manual event look
     * ingested.
     *
     * If the caller already posted the same `dedupKey` through the same
     * Connection, returns the id of that earlier event and writes nothing.
     * Fails with `Validation` if no plugin declares the kind or the payload
     * does not match the kind's schema, and with `NotFound` if the Connection
     * does not exist.
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

        // A kind that no plugin declares has no schema to check the payload
        // against, so the event is rejected.
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
        yield* Effect.mapError(
          decodeAgainstKind(payloadSchema, decoded.payload),
          createPayloadValidationError,
        );

        const actor = yield* currentStamp;
        const at = yield* nowIso;
        // A manual event happens when it is posted, so `occurred_at` and
        // `received_at` use the same clock read.
        const connectionId =
          decoded.connectionId === undefined ? null : uuidFromString(decoded.connectionId);
        // Without a key from the caller, every post is a separate event: two
        // identical posts are two things that happened, not one repeated.
        const dedupKey = decoded.dedupKey ?? crypto.randomUUID();
        // Store each ref once, as `amend` does: a caller that wrote a ref twice
        // meant one thing, and later readers compare against the stored list.
        const refs = [...new Set(decoded.refs ?? [])];

        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            // Later readers follow an event's Connection back to the account
            // the event came through, so an id that matches no Connection is
            // rejected rather than written. The connections domain appends
            // audit entries to this log and so depends on it. Reading the row
            // through that domain would create a cycle, so this query reads
            // the table directly.
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
            const appended = yield* appendEvent(sql, {
              source: MANUAL_SOURCE,
              connectionId,
              system: readSystemFromKind(decoded.kind),
              kind: decoded.kind,
              occurredAt: at,
              receivedAt: at,
              dedupKey,
              refs,
              payload: decoded.payload,
              actor,
            });
            if (appended !== undefined) return { eventId: appended };
            // The unique index blocked the insert, which means a manual event
            // with this key was posted through this Connection before. Return
            // the id of the event from that earlier post.
            const existing = yield* sql<{ readonly id: number }>`
              SELECT id FROM events
              WHERE source = ${MANUAL_SOURCE}
                AND ifnull(connection_id, x'') = ifnull(${connectionId}, x'')
                AND dedup_key = ${dedupKey}
            `;
            return { eventId: existing[0]!.id };
          }),
        );
      }),

    /**
     * Amends what one event is about and returns the amended event. Fields in
     * the input are overwritten and omitted fields stay as they were. Refs are
     * only added, so an event that has already matched on a ref never stops
     * matching on it.
     *
     * Only an event from outside the controller can be amended. An audit
     * entry, a platform event or a Scheduler tick records what the controller
     * itself did, and nothing may rewrite it: an added ref could make a run's
     * end match a subscription it was never about. Such an id fails with
     * `NotFound`, exactly like an id that matches nothing, so the log's
     * contents cannot be probed through this operation either.
     *
     * The caller opens the transaction, because the read and the write must be
     * in one transaction and the caller has more to put inside it.
     */
    amend: (input: Amendment): Effect.Effect<Event, NotFound | SqlError> =>
      Effect.gen(function* () {
        const rows = yield* sql<EventRow>`
          SELECT ${sql.literal(EVENT_COLUMNS)} FROM events WHERE id = ${input.id}
        `;
        const row = rows[0];
        if (row === undefined || isControllerSource(row.source)) {
          return yield* Effect.fail(createNotFoundError("no such event"));
        }
        const held = parseEventRow(row);

        const system = input.system ?? held.system;
        const url = input.url ?? held.url;
        const refs = mergeRefs(held.refs, input.refs ?? []);

        yield* sql`
          UPDATE events
          SET system = ${system}, url = ${url}, refs = ${JSON.stringify(refs)}
          WHERE id = ${input.id}
        `;
        // Nothing is announced: the live `event` topic is append-only, so an
        // amended event is not a new row, and a live view keeps showing the old
        // system, url and refs until it is loaded again.
        return { ...held, system, url, refs };
      }),
  };
});

/** The event log's operations: query, read, emit and amend. */
export class EventService extends Context.Service<EventService, Effect.Success<typeof make>>()(
  "hercule/controller/events/EventService",
) {}

export const EventServiceLayer: Layer.Layer<
  EventService,
  never,
  SqlClient.SqlClient | EventKindCatalog
> = Layer.effect(EventService)(make);
