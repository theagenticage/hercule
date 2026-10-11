/**
 * The event log's record: an event and the inputs that write and amend one.
 *
 * One table holds two kinds of entry in the same format: pipeline events,
 * which the event router evaluates against triggers, and audit entries, which
 * it never evaluates.
 *
 * An event's id is its position in the log, so it is an integer: the only
 * integer id in a system of UUIDv7s.
 *
 * The record lives apart from the `event` endpoints in `./event`, because the
 * signal, task and subscription schemas name an event's id, and `event.query`
 * names theirs in what came of each event. With both in one file, the two
 * would import each other.
 */
import { Schema } from "effect";
import {
  MAX_DEDUP_KEY_LENGTH,
  MAX_EVENT_AUTHOR_LENGTH,
  MAX_EVENT_SYSTEM_LENGTH,
  MAX_EVENT_TITLE_LENGTH,
  MAX_EVENT_URL_LENGTH,
} from "@hercule/plugin-host";
import { ExternalRef, Id, NullableActor, Timestamp } from "../ids";
import { bounded } from "../strings";

/**
 * The longest event kind. The part of a kind before its first dot is a
 * namespace, such as `github` in `github.issue.opened`. It is not always the
 * Event Source: `task.created` comes from the core.
 */
export const MAX_EVENT_KIND_LENGTH = 128;

export const EventKind = bounded(1, MAX_EVENT_KIND_LENGTH);

/** An arbitrary JSON object: a per-kind payload, or a vendor passthrough. */
const JsonObject = Schema.Record(Schema.String, Schema.Unknown);

/** An event's id: its position in the log, counted from one. */
export const EventId = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export type EventId = Schema.Schema.Type<typeof EventId>;

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
  /**
   * One line saying what happened, set by the emitter: "marta requested your
   * review on #1293". Null for an event stored before sources set it, and for
   * an event sent with `event.emit`.
   */
  title: Schema.NullOr(Schema.String),
  /** Who caused the event on its own system, such as a GitHub login, or null when nobody did. */
  author: Schema.NullOr(Schema.String),
});

export type Event = Schema.Schema.Type<typeof Event>;

/** The log is sorted by position only. */
export const EVENT_SORT_FIELDS = ["id"] as const;

/**
 * Re-exported from the package plugins are written against, so a plugin
 * checks its events against the limits this API checks.
 */
export {
  MAX_DEDUP_KEY_LENGTH,
  MAX_EVENT_AUTHOR_LENGTH,
  MAX_EVENT_SYSTEM_LENGTH,
  MAX_EVENT_TITLE_LENGTH,
  MAX_EVENT_URL_LENGTH,
};

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
