/**
 * The event log, read.
 *
 * One table holds two populations under one envelope: pipeline events, which
 * the matcher will evaluate against triggers, and audit entries, which it never
 * will. Both come back from `query`, told apart by `kind`, because the log is
 * also the audit log and the reason to open it is usually to read a security
 * entry beside the events around it. One population filter applies: the
 * security entries - the audit kinds of the secret, auth and user account
 * families - are returned only to a caller that also holds `event.audit`. To
 * anyone else they are absent from the page rather than refused, and `read` of
 * one answers not-found, so the log does not confirm what it withholds.
 *
 * An event's id is its position in the log, so it is an integer, and the one
 * integer id in a system of UUIDv7s.
 *
 * Two filters spec 11 names are missing here, `triggerId` and `runId`: triggers
 * and runs do not exist yet, and a filter that always answers empty tells the
 * caller something untrue. The workflows ticket completes this operation.
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

const EventKind = bounded(1, MAX_EVENT_KIND_LENGTH);

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

/** The log is walked by position, and by nothing else. */
export const EVENT_SORT_FIELDS = ["id"] as const;

export const event = HttpApiGroup.make("event")
  .add(
    HttpApiEndpoint.get("query", "/events", {
      query: Schema.Struct({
        connectionId: Schema.optionalKey(Id),
        kind: Schema.optionalKey(EventKind),
        /**
         * Both bound `receivedAt`, when the log took the event, not
         * `occurredAt`, when the source says it happened. Arrival is the log's
         * own axis and the one its ids run with, so a window and the order a
         * page comes back in never disagree; an emitter's claim about when
         * something happened is neither.
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
  )
  .middleware(Authenticated);
