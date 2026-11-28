/**
 * The facts each event `event.query` lists carries: the signals that name the
 * event, and the live Subscriptions that received it. Triage reads them to set
 * aside what is already known or in flight, and to never raise a signal twice
 * (spec 10 section 2.2).
 *
 * This domain cannot import the signals, subscriptions, sessions or runs
 * domains, because they import this one. So it reads their tables directly.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { Fragment } from "effect/sql/Statement";
import type { EventKnownByFact, EventSignalFact } from "@hercule/contract";
import { uuidToString } from "../db";

/**
 * Builds the tables of the signals that name an event in `signal_events`: one
 * a plugin raised from the event, or a core signal that lists it as evidence.
 * A query reads the event's id as `se.event_id` and the signal as `s`.
 *
 * Intake's filter and the facts both read it, so the two agree on which
 * signals name an event.
 */
export const buildSignalsNamingEvent = (sql: SqlClient.SqlClient): Fragment =>
  sql`signal_events se JOIN signals s ON s.id = se.signal_id`;

/** The facts of one listed event. */
export interface EventFacts {
  readonly signals: ReadonlyArray<EventSignalFact>;
  readonly knownBy: ReadonlyArray<EventKnownByFact>;
}

/** Groups rows by the event they are about, keeping each event's rows in the order read. */
const groupByEvent = <Row extends { readonly event_id: number }, Fact>(
  rows: ReadonlyArray<Row>,
  buildFact: (row: Row) => Fact,
): ReadonlyMap<number, ReadonlyArray<Fact>> => {
  const groups = new Map<number, Array<Fact>>();
  for (const row of rows) {
    const group = groups.get(row.event_id);
    if (group === undefined) groups.set(row.event_id, [buildFact(row)]);
    else group.push(buildFact(row));
  }
  return groups;
};

interface SignalRow {
  readonly event_id: number;
  readonly signal_id: Uint8Array;
  readonly kind: string;
  readonly status: "open" | "resolved";
  readonly title: string;
  readonly outcome: string | null;
}

interface KnownByRow {
  readonly event_id: number;
  readonly subscription_id: Uint8Array;
  readonly holder_kind: "session" | "run";
  readonly holder_id: Uint8Array;
}

/**
 * Reads the facts of the events with these ids, in one query for each kind of
 * fact whatever the number of events. The result has an entry for every id,
 * with empty lists for an event no signal names and no live Subscription
 * received.
 *
 * Each list is in the order its facts were created, oldest first.
 */
export const readEventFacts = (
  sql: SqlClient.SqlClient,
  ids: ReadonlyArray<number>,
): Effect.Effect<ReadonlyMap<number, EventFacts>, SqlError> =>
  Effect.gen(function* () {
    if (ids.length === 0) return new Map();
    const signalRows = yield* sql<SignalRow>`
      SELECT se.event_id AS event_id, s.id AS signal_id, s.kind AS kind, s.status AS status,
             s.title AS title,
             CASE WHEN s.status = 'resolved' THEN json_extract(s.resolution, '$.outcome') END AS outcome
      FROM ${buildSignalsNamingEvent(sql)}
      WHERE se.event_id IN ${sql.in(ids)}
      ORDER BY s.created_at, s.id
    `;
    // A session receives an event as an input queued from its Subscription. A
    // run receives one as a step record started by a signal trigger: a run
    // holds one Subscription per signal trigger, and the step record's
    // `step_id` is that trigger's id, so only the Subscription that received
    // the event matches. `CROSS JOIN` makes SQLite read the step records
    // first, through the index on their event, and then find the
    // Subscription. Left to choose, it can read every run's Subscriptions for
    // each event.
    //
    // A Subscription receives an event once: a session holds one input per
    // Subscription and event, and a run one step record per trigger and
    // event. A session's and a run's Subscriptions are different rows, so the
    // two halves never repeat a row.
    const knownByRows = yield* sql<KnownByRow>`
      SELECT si.event_id AS event_id, sub.id AS subscription_id, sub.holder_kind AS holder_kind,
             sub.holder_id AS holder_id, sub.created_at AS created_at
      FROM session_inputs si JOIN subscriptions sub ON sub.id = si.subscription_id
      WHERE sub.ended_at IS NULL AND si.event_id IN ${sql.in(ids)}
      UNION ALL
      SELECT rs.event_id AS event_id, sub.id AS subscription_id, sub.holder_kind AS holder_kind,
             sub.holder_id AS holder_id, sub.created_at AS created_at
      FROM run_steps rs CROSS JOIN subscriptions sub
        ON sub.holder_kind = 'run'
        AND sub.holder_id = rs.run_id
        AND json_extract(sub.target, '$.triggerId') = rs.step_id
      WHERE sub.ended_at IS NULL AND rs.event_id IN ${sql.in(ids)}
      ORDER BY created_at, subscription_id
    `;

    const signals = groupByEvent(signalRows, (row): EventSignalFact => ({
      signalId: uuidToString(row.signal_id),
      kind: row.kind,
      status: row.status,
      title: row.title,
      ...(row.outcome === null ? {} : { outcome: row.outcome }),
    }));
    const knownBy = groupByEvent(knownByRows, (row): EventKnownByFact => ({
      subscriptionId: uuidToString(row.subscription_id),
      holder: { kind: row.holder_kind, id: uuidToString(row.holder_id) },
    }));
    return new Map(
      ids.map((id) => [id, { signals: signals.get(id) ?? [], knownBy: knownBy.get(id) ?? [] }]),
    );
  });
