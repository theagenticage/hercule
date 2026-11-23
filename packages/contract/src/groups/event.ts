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
 * Each event `query` returns carries the signals that name it and the live
 * Subscriptions that received it, read for the whole page at once, so triage
 * can tell what is already known or in flight with no request per event
 * (spec 10 section 2.2).
 *
 * The `runId` filter from spec 11 is missing here: events are not linked to
 * runs yet, and a filter that always returns an empty page would mislead the
 * caller.
 */
import { Schema, Struct } from "effect";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import { Forbidden, Internal, NotFound, Unauthenticated, Validation } from "../errors";
import { Id, Timestamp } from "../ids";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { bounded } from "../strings";
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
 * The audit kinds a machine's activity shows: the changes to a runner, to a
 * workspace on it and to a session on it. An entry of one of these kinds names
 * its runner in `payload.runnerId`, and the writer copies that id into the
 * event's `runner_id` column, so `event.query` can read one runner's activity
 * as a single index range.
 *
 * Two families are left out on purpose:
 *
 * - `workspace.observed` is written on most observations of a workspace, and
 *   would bury the rest of the activity.
 * - `runner.joinToken.*` concerns a token, not a runner: no runner has joined
 *   yet when a token is minted.
 *
 * Every other audit kind, and every other event, is stored with no runner.
 * `event.query`'s `runnerId` returns only entries of these kinds.
 */
export const RUNNER_ACTIVITY_KINDS = [
  "runner.joined",
  "runner.stateChanged",
  "runner.updated",
  "runner.drained",
  "runner.undrained",
  "runner.placementsChanged",
  "runner.crashLooping",
  "runner.retired",
  "workspace.created",
  "workspace.disposalRequested",
  "workspace.disposalRefused",
  "workspace.deleted",
  "workspace.detached",
  "workspace.attachmentRetried",
  "session.spawned",
  "session.stopped",
  "session.reconciled",
  "session.archived",
  "providerAccount.signedIn",
] as const;

export type RunnerActivityKind = (typeof RUNNER_ACTIVITY_KINDS)[number];

/**
 * The longest `source` the filter accepts. A source is a plugin's id or a
 * core emitter's name, both far shorter.
 */
export const MAX_EVENT_SOURCE_LENGTH = 128;

/**
 * A signal that names the event: one a plugin raised from it
 * (`origin.eventId`), or a core signal that lists it among its evidence
 * (`origin.eventIds`). A plugin's kind is raised only from its event, and a
 * core kind only lists events, so `kind` tells the two apart.
 *
 * Triage reads these so it never raises a core signal that repeats a plugin
 * signal, and never raises again over events whose signal the user resolved.
 */
export const EventSignalFact = Schema.Struct({
  signalId: Id,
  kind: SignalKind,
  status: SignalStatus,
  title: Schema.String,
  /** The signal's one-line outcome, such as "Replied in Gmail". Set only once it is resolved. */
  outcome: Schema.optionalKey(Schema.String),
});

export type EventSignalFact = Schema.Schema.Type<typeof EventSignalFact>;

/**
 * A live Subscription that received the event, and who holds it. Triage reads
 * these to set aside an event that work in flight already consumed.
 */
export const EventKnownByFact = Schema.Struct({
  subscriptionId: Id,
  holder: SubscriptionHolder,
});

export type EventKnownByFact = Schema.Schema.Type<typeof EventKnownByFact>;

/**
 * An event as `event.query` lists it: the event without its `raw`, with the
 * signals that name it and the live Subscriptions that received it. Each list
 * is oldest first, and empty when there is none.
 *
 * The vendor payload is kept for debugging, no filter or mapping reads it,
 * and it can be large, so a page of events would pay for it on every row.
 * `event.read` still returns it. The `payload` stays, because triage agents
 * read it from `event list --intake`.
 */
export const ListedEvent = Event.mapFields((fields) => ({
  ...Struct.omit(fields, ["raw"]),
  signals: Schema.Array(EventSignalFact),
  knownBy: Schema.Array(EventKnownByFact),
}));

export type ListedEvent = Schema.Schema.Type<typeof ListedEvent>;

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
    Schema.isBetweenLength(EVENT_COUNT_HOURS, EVENT_COUNT_HOURS),
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
        /**
         * Only the events a start trigger holds: matched while its spawn
         * bound was spent, and waiting to start a run. Set both or neither,
         * because a trigger id is unique only within its workflow.
         */
        workflowId: Schema.optionalKey(Id),
        triggerId: Schema.optionalKey(Schema.String),
        /**
         * Only the audit entries about this runner, a workspace on it, or a
         * session on it, of the kinds that show a machine's activity (spec 04
         * "Events by runner").
         */
        runnerId: Schema.optionalKey(Id),
        ...pageParams(EVENT_SORT_FIELDS).fields,
      }),
      success: page(ListedEvent),
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
