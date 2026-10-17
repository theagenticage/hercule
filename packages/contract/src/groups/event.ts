/**
 * The event log, read.
 *
 * `query` returns pipeline events and audit entries alike, told apart by
 * `kind`, because the log is also the audit log, and people usually open it to
 * read a security entry next to the events around it.
 *
 * Security entries - the audit kinds of the secret, auth and user account
 * families - are returned only to a caller that also holds `event.audit`. For
 * anyone else they are left out of the page rather than rejected, and `read`
 * of one fails with not_found, so the log does not reveal what it withholds.
 *
 * Each event `query` returns carries the facts its handlings are worked out
 * from: the signals, Tasks and Subscriptions it reached. A client turns them
 * into "What came of it" with no request per row (spec 10 section 9.10).
 *
 * The `runId` filter from spec 11 is missing here: events are not linked to
 * runs yet, and a filter that always returns an empty page would mislead the
 * caller.
 */
import { Schema, Struct } from "effect";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { Forbidden, Internal, NotFound, Unauthenticated, Validation } from "../errors";
import { Id, Timestamp } from "../ids";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { atMost, bounded } from "../strings";
import {
  EVENT_SORT_FIELDS,
  Event,
  EventEmitInput,
  EventEmitted,
  EventEnrichInput,
  EventId,
  EventKind,
} from "./event-record";
import { SignalKind, SignalStatus } from "./signal";
import { SubscriptionHolder } from "./subscription";
import { MAX_SEARCH_TEXT_LENGTH } from "./task";

/**
 * The handlings `event.query` can filter on: what came of an event in Intake,
 * in the order "What came of it" shows them (spec 10 section 9.10).
 *
 * - `raised-signal`: the event raised a plugin's signal.
 * - `ended-signal`: the event ended a signal on its source.
 * - `ignored`: an Ignore Rule stopped the signal the event would have raised.
 * - `evidence`: a core signal, such as triage's proposal, lists the event.
 * - `on-task`: a Task's provenance carries the event.
 * - `known-work`: a live Subscription received the event.
 * - `no-action`: none of the above.
 *
 * Three more join later, each with what it is worked out from: the
 * Screener's two with Screening, and `pending-triage` with the setting that
 * names the triage workflow. Until then nothing could produce them, so they
 * are not values a caller can send.
 */
export const EVENT_HANDLINGS = [
  "raised-signal",
  "ended-signal",
  "ignored",
  "evidence",
  "on-task",
  "known-work",
  "no-action",
] as const;

export const EventHandling = Schema.Literals(EVENT_HANDLINGS);

export type EventHandling = Schema.Schema.Type<typeof EventHandling>;

/**
 * The longest `source` the filter accepts. A source is a plugin's id or a
 * core emitter's name, both far shorter.
 */
export const MAX_EVENT_SOURCE_LENGTH = 128;

/**
 * A signal the event raised (`origin.eventId`), or a core signal that lists
 * the event among its evidence (`origin.eventIds`). A plugin's kind is raised
 * only from its event, and a core kind only lists events, so `kind` tells the
 * two apart.
 */
export const EventSignalFact = Schema.Struct({
  signalId: Id,
  kind: SignalKind,
  status: SignalStatus,
  title: Schema.String,
  /** When the signal comes back to To do. Set only while it is open and snoozed. */
  snoozedUntil: Schema.optionalKey(Timestamp),
  /** The signal's one-line outcome, such as "Replied in Gmail". Set only once it is resolved. */
  outcome: Schema.optionalKey(Schema.String),
});

export type EventSignalFact = Schema.Schema.Type<typeof EventSignalFact>;

/** A signal the event ended on its source (`resolution.eventId`). */
export const EventResolvedSignalFact = Schema.Struct({
  signalId: Id,
  title: Schema.String,
  outcome: Schema.String,
});

export type EventResolvedSignalFact = Schema.Schema.Type<typeof EventResolvedSignalFact>;

/** A Task whose provenance carries the event. A deleted Task is not listed. */
export const EventTaskFact = Schema.Struct({
  taskId: Id,
  title: Schema.String,
});

export type EventTaskFact = Schema.Schema.Type<typeof EventTaskFact>;

/** A live Subscription that received the event, and who holds it. */
export const EventKnownByFact = Schema.Struct({
  subscriptionId: Id,
  holder: SubscriptionHolder,
  /** The holding session's title, or the name of the holding run's workflow. Null when it has none. */
  title: Schema.NullOr(Schema.String),
});

export type EventKnownByFact = Schema.Schema.Type<typeof EventKnownByFact>;

/**
 * The Ignore Rule that caught the event: the signal the event would have
 * raised was never created. `text` is the rule's text as it was when it
 * caught the event, so the fact still names a rule the user has since
 * deleted. `ruleDeleted` is true once the rule is gone.
 */
export const EventIgnoredByFact = Schema.Struct({
  ruleId: Id,
  kind: SignalKind,
  text: Schema.String,
  ruleDeleted: Schema.Boolean,
});

export type EventIgnoredByFact = Schema.Schema.Type<typeof EventIgnoredByFact>;

/**
 * What came of one event: the signals it raised or is evidence for, the
 * signals it ended, the first Ignore Rule that caught it, the Tasks it is on, and
 * the live Subscriptions that received it. Each list is empty when the event
 * reached nothing of its kind, and `ignoredBy` is null when no rule caught it.
 */
export const EventFacts = Schema.Struct({
  signals: Schema.Array(EventSignalFact),
  resolvedSignals: Schema.Array(EventResolvedSignalFact),
  ignoredBy: Schema.NullOr(EventIgnoredByFact),
  tasks: Schema.Array(EventTaskFact),
  knownBy: Schema.Array(EventKnownByFact),
});

export type EventFacts = Schema.Schema.Type<typeof EventFacts>;

/**
 * An event as `event.query` lists it: the event and its facts. The facts are
 * read after the page of events, one query for each kind of fact.
 *
 * A listed event carries no `raw`. The vendor payload is kept for debugging,
 * no filter or mapping reads it, and it can be large, so a page of events
 * would pay for it on every row. `event.read` still returns it. The `payload`
 * stays, because triage agents read it from `event list --intake`.
 */
export const EventWithFacts = Event.mapFields((fields) => ({
  ...Struct.omit(fields, ["raw"]),
  ...EventFacts.fields,
}));

export type EventWithFacts = Schema.Schema.Type<typeof EventWithFacts>;

/** How many hours `event.countByConnection` counts back from now, one count per hour. */
export const EVENT_COUNT_HOURS = 24;

/**
 * The events one Connection received in the last `EVENT_COUNT_HOURS` hours,
 * one count per hour, oldest first. The hours are counted back from the
 * moment of the request: the last count is the 60 minutes before it, the one
 * before that the 60 minutes before those, and so on. A manual event posted
 * with a Connection counts as that Connection's.
 */
export const ConnectionEventCounts = Schema.Struct({
  connectionId: Id,
  hourly: Schema.Array(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))).check(
    Schema.isLengthBetween(EVENT_COUNT_HOURS, EVENT_COUNT_HOURS),
  ),
});

export type ConnectionEventCounts = Schema.Schema.Type<typeof ConnectionEventCounts>;

/**
 * What `event.countByConnection` returns: an entry for each Connection that
 * received at least one event in the last `EVENT_COUNT_HOURS` hours. A
 * Connection with no entry received none.
 */
export const EventCountsByConnection = Schema.Struct({
  connections: Schema.Array(ConnectionEventCounts),
});

export type EventCountsByConnection = Schema.Schema.Type<typeof EventCountsByConnection>;

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
        /**
         * `true` returns only Intake's events: those whose kind triage may read
         * for their Connection, under today's Intake settings, and every event
         * behind a signal. Absent or `false` returns every event.
         */
        intake: Schema.optionalKey(Schema.Boolean),
        /**
         * Words that must all appear in the event's title or author. The page
         * stays newest first: a search narrows the log and never reorders it.
         * An event with neither field never matches.
         */
        text: Schema.optionalKey(bounded(1, MAX_SEARCH_TEXT_LENGTH)),
        /** Only events from this source: a plugin's id, or a core emitter such as `manual`. */
        source: Schema.optionalKey(bounded(1, MAX_EVENT_SOURCE_LENGTH)),
        /** Only events with at least one of these handlings. */
        handling: Schema.optionalKey(atMost(EventHandling, EVENT_HANDLINGS.length)),
        /**
         * Only the events a start trigger holds: matched while its spawn
         * bound was spent, and waiting to start a run. Set both or neither,
         * because a trigger id is unique only within its workflow.
         */
        workflowId: Schema.optionalKey(Id),
        triggerId: Schema.optionalKey(Schema.String),
        ...pageParams(EVENT_SORT_FIELDS).fields,
      }),
      success: page(EventWithFacts),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    // A summary of the log, so the Connections screen can show what each
    // Connection brought in without paging through every event.
    HttpApiEndpoint.get("countByConnection", "/events/counts", {
      success: EventCountsByConnection,
      error: [Unauthenticated, Forbidden, Internal],
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
