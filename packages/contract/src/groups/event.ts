/**
 * The event log, read.
 *
 * One table holds two kinds of entry in the same format: pipeline events,
 * which the event router evaluates against triggers, and audit entries, which
 * it never evaluates. `query` returns both, told apart by `kind`, because the
 * log is also the audit log, and people usually open it to read a security
 * entry next to the events around it.
 *
 * Security entries - the audit kinds of the secret, auth and user account
 * families - are returned only to a caller that also holds `event.audit`. For
 * anyone else they are left out of the page rather than rejected, and `read`
 * of one fails with not_found, so the log does not reveal what it withholds.
 *
 * An event's id is its position in the log, so it is an integer: the only
 * integer id in a system of UUIDv7s.
 *
 * Two filters from spec 11, `triggerId` and `runId`, are missing here: events
 * are not linked to triggers or runs yet, and a filter that always returns an
 * empty page would mislead the caller.
 */
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Forbidden, Internal, NotFound, Unauthenticated, Validation } from "../errors";
import { ExternalRef, Id, NullableActor, Timestamp } from "../ids";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { bounded } from "../strings";

/** The longest event kind. Namespaced by source: `github.issue.opened`. */
export const MAX_EVENT_KIND_LENGTH = 128;

export const EventKind = bounded(1, MAX_EVENT_KIND_LENGTH);

/** An arbitrary JSON object: a per-kind payload, or a vendor passthrough. */
const JsonObject = Schema.Record(Schema.String, Schema.Unknown);

/** An event's id: its position in the log, counted from one. */
export const EventId = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const Event = Schema.Struct({
  id: EventId,
  /** The plugin or core emitter: `github`, `gmail`, `cron`, `manual`, `platform`. */
  source: Schema.String,
  /** Null for core emitters, which arrive through no connection. */
  connectionId: Schema.NullOr(Id),
  /** The external system the event is about, which enrichment may correct. */
  system: Schema.String,
  kind: EventKind,
  occurredAt: Timestamp,
  receivedAt: Timestamp,
  /** The emitter's idempotency key, unique per connection. */
  dedupKey: Schema.String,
  refs: Schema.Array(ExternalRef),
  /** Where a person opens this event in its own system. */
  url: Schema.NullOr(Schema.String),
  payload: JsonObject,
  /** The vendor payload, kept for debugging. No filter ever reads it. */
  raw: Schema.NullOr(JsonObject),
  /**
   * Who caused it, or nobody. The envelope is the only place the actor lives;
   * a platform event's payload never repeats it.
   */
  actor: NullableActor,
});

export type Event = Schema.Schema.Type<typeof Event>;

/** The log is sorted by position only. */
export const EVENT_SORT_FIELDS = ["id"] as const;

/** The longest idempotency key an emitter may write. */
export const MAX_DEDUP_KEY_LENGTH = 200;

/** The longest system name. It is the name of a system, not a sentence. */
export const MAX_EVENT_SYSTEM_LENGTH = 64;

/** The longest source URL. It is where a person opens the event, not a document. */
export const MAX_EVENT_URL_LENGTH = 2048;

/** The payload of a manual emit. The core fills in every other field of the event. */
export const EventEmitInput = Schema.Struct({
  kind: EventKind,
  payload: JsonObject,
  connectionId: Schema.optionalKey(Id),
  refs: Schema.optionalKey(Schema.Array(ExternalRef)),
  dedupKey: Schema.optionalKey(bounded(1, MAX_DEDUP_KEY_LENGTH)),
});

export type EventEmitInput = Schema.Schema.Type<typeof EventEmitInput>;

/** The id of the event a manual emit wrote. */
export const EventEmitted = Schema.Struct({ eventId: EventId });

export type EventEmitted = Schema.Schema.Type<typeof EventEmitted>;

/**
 * The fields enrichment may amend. A field left out is not changed. `refs` are
 * only ever added, never removed, so a later reader of an event never finds
 * fewer refs on it than an earlier one did.
 */
export const EventEnrichInput = Schema.Struct({
  system: Schema.optionalKey(bounded(1, MAX_EVENT_SYSTEM_LENGTH)),
  url: Schema.optionalKey(bounded(1, MAX_EVENT_URL_LENGTH)),
  refs: Schema.optionalKey(Schema.Array(ExternalRef)),
});

export type EventEnrichInput = Schema.Schema.Type<typeof EventEnrichInput>;

export const event = HttpApiGroup.make("event")
  .add(
    HttpApiEndpoint.get("query", "/events", {
      query: Schema.Struct({
        connectionId: Schema.optionalKey(Id),
        kind: Schema.optionalKey(EventKind),
        /**
         * Both filter on `receivedAt`, when the log stored the event, not on
         * `occurredAt`, when the source claims it happened. Event ids follow
         * arrival order, so a time window and the order of a page always
         * agree. An emitter's claim about when something happened has neither
         * property.
         */
        since: Schema.optionalKey(Timestamp),
        until: Schema.optionalKey(Timestamp),
        ...pageParams(EVENT_SORT_FIELDS).fields,
      }),
      success: page(Event),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.get("read", "/events/:id", {
      params: { id: Schema.FiniteFromString.pipe(Schema.decodeTo(EventId)) },
      success: Event,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    /**
     * A synthetic event, posted by hand. A manual `github.issue.opened` reaches
     * a subscription the same way an ingested one does; a filter that has to
     * tell the two apart reads `event.source`.
     */
    HttpApiEndpoint.post("emit", "/events/emit", {
      payload: EventEmitInput,
      success: EventEmitted,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("enrich", "/events/:id/enrich", {
      params: { id: Schema.FiniteFromString.pipe(Schema.decodeTo(EventId)) },
      payload: EventEnrichInput,
      success: Event,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
  )
  .middleware(Authenticated);
