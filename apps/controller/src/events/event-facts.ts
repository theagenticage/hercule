/**
 * What came of an event: the signals it raised or is evidence for, the
 * signals it ended, the Tasks it is on, and the live Subscriptions that
 * received it (spec 10 section 9.10).
 *
 * `event.query` uses the same definitions twice: once as the `handling`
 * filter, which asks of each event "is there such a fact?", and once to list
 * the facts of the events on the page. Each kind of fact is defined once, as
 * a `FactSource`, so the filter and the list can never disagree about what
 * counts.
 *
 * This domain cannot import the signals, tasks, subscriptions, sessions or
 * runs domains, because they import this one. So it reads their tables.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Fragment } from "effect/unstable/sql/Statement";
import {
  CORE_SIGNAL_KINDS,
  type EventHandling,
  type EventKnownByFact,
  type EventResolvedSignalFact,
  type EventSignalFact,
  type EventTaskFact,
} from "@hercule/contract";
import { nowIso, uuidToString } from "../db";

/**
 * Where one kind of fact is stored. A query adds its own condition on the
 * event, so one definition serves the filter (`eventId = +events.id`) and the
 * list (`eventId IN (the page's ids)`).
 */
interface FactSource {
  /** The tables the fact is read from, with their joins. */
  readonly from: Fragment;
  /** What a row must satisfy to be a fact, apart from naming the event. */
  readonly where: ReadonlyArray<Fragment>;
  /** The expression that holds the id of the event the fact is about. */
  readonly eventId: Fragment;
}

/** The facts of one event. Each list is empty when the event reached nothing of its kind. */
export interface EventFacts {
  readonly signals: ReadonlyArray<EventSignalFact>;
  readonly resolvedSignals: ReadonlyArray<EventResolvedSignalFact>;
  readonly tasks: ReadonlyArray<EventTaskFact>;
  readonly knownBy: ReadonlyArray<EventKnownByFact>;
}

/** The facts of an event that reached nothing. */
export const NO_FACTS: EventFacts = { signals: [], resolvedSignals: [], tasks: [], knownBy: [] };

/**
 * Builds the sources of every kind of fact.
 *
 * Two of them read an expression index from migration 0072, so their
 * expression must be written exactly as the index writes it, or SQLite
 * does not use the index: `json_extract(resolution, '$.eventId')`.
 */
const buildFactSources = (sql: SqlClient.SqlClient) => ({
  /**
   * A signal that names the event in `signal_events`: one a plugin raised
   * from the event, or a core signal that lists it as evidence. The signal's
   * kind tells the two apart.
   */
  signalsNamingEvent: {
    from: sql`signal_events se JOIN signals s ON s.id = se.signal_id`,
    where: [],
    eventId: sql`se.event_id`,
  } satisfies FactSource,
  /** A signal the event ended on its source, so the event is in its resolution. */
  signalsEndedByEvent: {
    from: sql`signals s`,
    where: [],
    eventId: sql`json_extract(s.resolution, '$.eventId')`,
  } satisfies FactSource,
  /** A Task that has not been deleted, and whose provenance names the event. */
  tasksFromEvent: {
    from: sql`task_provenance tp JOIN tasks t ON t.id = tp.task_id`,
    where: [sql`t.deleted_at IS NULL`],
    eventId: sql`tp.event_id`,
  } satisfies FactSource,
  /** A live Subscription held by a session, which queued the event as an input. */
  subscriptionsOfSessions: {
    from: sql`session_inputs si JOIN subscriptions sub ON sub.id = si.subscription_id`,
    where: [sql`sub.ended_at IS NULL`],
    eventId: sql`si.event_id`,
  } satisfies FactSource,
  /**
   * A live Subscription held by a run, whose signal trigger started a step
   * record for the event. A run holds one Subscription per signal trigger,
   * and the step record's `step_id` is that trigger's id, so only the
   * Subscription that received the event matches.
   *
   * `CROSS JOIN` makes SQLite read the step records first, through the index
   * on their event, and then find the Subscription. Left to choose, it can
   * read every run's Subscriptions for each event.
   */
  subscriptionsOfRuns: {
    from: sql`run_steps rs CROSS JOIN subscriptions sub
      ON sub.holder_kind = 'run'
      AND sub.holder_id = rs.run_id
      AND json_extract(sub.target, '$.triggerId') = rs.step_id`,
    where: [sql`sub.ended_at IS NULL`],
    eventId: sql`rs.event_id`,
  } satisfies FactSource,
});

/**
 * Builds the condition that the event the outer query is reading has a fact
 * of this source, optionally narrowed by more conditions on the fact.
 *
 * The unary plus in `+events.id` strips the column's integer affinity. With
 * the affinity, SQLite will not use an expression index such as
 * `signals_resolution_event` to look the event up, and reads the whole index
 * for each event.
 */
const buildHasFact = (
  sql: SqlClient.SqlClient,
  source: FactSource,
  narrowedBy: ReadonlyArray<Fragment> = [],
): Fragment =>
  sql`EXISTS (
    SELECT 1 FROM ${source.from}
    WHERE ${sql.and([...source.where, ...narrowedBy, sql`${source.eventId} = +events.id`])}
  )`;

/**
 * Builds the condition that the event the outer query is reading is one of
 * Intake's events because a signal is behind it: it raised a signal, is
 * evidence for one, or ended one.
 */
export const buildHasSignalBehind = (sql: SqlClient.SqlClient): Fragment => {
  const sources = buildFactSources(sql);
  return sql.or([
    buildHasFact(sql, sources.signalsNamingEvent),
    buildHasFact(sql, sources.signalsEndedByEvent),
  ]);
};

/**
 * Builds the condition that a live Subscription received the event the outer
 * query is reading.
 */
const buildHasKnownWork = (sql: SqlClient.SqlClient): Fragment => {
  const sources = buildFactSources(sql);
  return sql.or([
    buildHasFact(sql, sources.subscriptionsOfSessions),
    buildHasFact(sql, sources.subscriptionsOfRuns),
  ]);
};

/**
 * Builds the condition for one handling, on the event the outer query is
 * reading. `no-action` holds when none of the others does.
 */
const buildHandling = (sql: SqlClient.SqlClient, handling: EventHandling): Fragment => {
  const sources = buildFactSources(sql);
  const coreKinds = sql.in(CORE_SIGNAL_KINDS);
  switch (handling) {
    case "raised-signal":
      return buildHasFact(sql, sources.signalsNamingEvent, [sql`s.kind NOT IN ${coreKinds}`]);
    case "evidence":
      return buildHasFact(sql, sources.signalsNamingEvent, [sql`s.kind IN ${coreKinds}`]);
    case "ended-signal":
      return buildHasFact(sql, sources.signalsEndedByEvent);
    case "on-task":
      return buildHasFact(sql, sources.tasksFromEvent);
    case "known-work":
      return buildHasKnownWork(sql);
    case "no-action":
      return sql`NOT (${sql.or([
        buildHasSignalBehind(sql),
        buildHasFact(sql, sources.tasksFromEvent),
        buildHasKnownWork(sql),
      ])})`;
  }
};

/**
 * Builds the condition that an event has at least one of these handlings.
 * `handlings` must not be empty.
 */
export const buildAnyHandling = (
  sql: SqlClient.SqlClient,
  handlings: ReadonlyArray<EventHandling>,
): Fragment => sql.or(handlings.map((handling) => buildHandling(sql, handling)));

/** Groups rows by the event they are about, keeping each event's rows in the order read. */
const groupByEvent = <Row extends { readonly event_id: number }, Fact>(
  rows: ReadonlyArray<Row>,
  toFact: (row: Row) => Fact,
): ReadonlyMap<number, ReadonlyArray<Fact>> => {
  const groups = new Map<number, Array<Fact>>();
  for (const row of rows) {
    const group = groups.get(row.event_id);
    if (group === undefined) groups.set(row.event_id, [toFact(row)]);
    else group.push(toFact(row));
  }
  return groups;
};

interface SignalRow {
  readonly event_id: number;
  readonly signal_id: Uint8Array;
  readonly kind: string;
  readonly status: "open" | "resolved";
  readonly title: string;
  readonly snoozed_until: string | null;
  readonly outcome: string | null;
}

interface ResolvedSignalRow {
  readonly event_id: number;
  readonly signal_id: Uint8Array;
  readonly kind: string;
  readonly title: string;
  readonly outcome: string;
}

interface TaskRow {
  readonly event_id: number;
  readonly task_id: Uint8Array;
  readonly title: string;
}

interface KnownByRow {
  readonly event_id: number;
  readonly subscription_id: Uint8Array;
  readonly holder_kind: "session" | "run";
  readonly holder_id: Uint8Array;
  readonly title: string | null;
}

/**
 * Reads the facts of the events with these ids, in one query for each kind of
 * fact whatever the number of events. An event that reached nothing has no
 * entry in the result.
 *
 * Each list is in the order its facts were created, oldest first, so a
 * reader sees them in a fixed order.
 */
export const readEventFacts = (
  sql: SqlClient.SqlClient,
  ids: ReadonlyArray<number>,
): Effect.Effect<ReadonlyMap<number, EventFacts>, SqlError> =>
  Effect.gen(function* () {
    if (ids.length === 0) return new Map();
    const sources = buildFactSources(sql);
    const now = yield* nowIso;
    const named = (source: FactSource) =>
      sql.and([...source.where, sql`${source.eventId} IN ${sql.in(ids)}`]);

    const signalRows = yield* sql<SignalRow>`
      SELECT se.event_id AS event_id, s.id AS signal_id, s.kind AS kind, s.status AS status,
             s.title AS title,
             CASE WHEN s.status = 'open'
               THEN (SELECT z.until FROM signal_snoozes z WHERE z.signal_id = s.id AND z.until > ${now})
             END AS snoozed_until,
             CASE WHEN s.status = 'resolved' THEN json_extract(s.resolution, '$.outcome') END AS outcome
      FROM ${sources.signalsNamingEvent.from}
      WHERE ${named(sources.signalsNamingEvent)}
      ORDER BY s.created_at, s.id
    `;
    const resolvedRows = yield* sql<ResolvedSignalRow>`
      SELECT ${sources.signalsEndedByEvent.eventId} AS event_id, s.id AS signal_id, s.kind AS kind,
             s.title AS title, json_extract(s.resolution, '$.outcome') AS outcome
      FROM ${sources.signalsEndedByEvent.from}
      WHERE ${named(sources.signalsEndedByEvent)}
      ORDER BY s.created_at, s.id
    `;
    // A Task whose provenance names the event twice is one fact.
    const taskRows = yield* sql<TaskRow>`
      SELECT tp.event_id AS event_id, t.id AS task_id, t.title AS title
      FROM ${sources.tasksFromEvent.from}
      WHERE ${named(sources.tasksFromEvent)}
      GROUP BY tp.event_id, t.id
      ORDER BY t.created_at, t.id
    `;
    // One Subscription receives an event once, and a session's and a run's
    // Subscriptions are different rows, so the two lists never repeat a row.
    const knownByRows = yield* sql<KnownByRow>`
      SELECT * FROM (
        SELECT si.event_id AS event_id, sub.id AS subscription_id, sub.holder_kind AS holder_kind,
               sub.holder_id AS holder_id, sub.created_at AS created_at,
               (SELECT sessions.title FROM sessions WHERE sessions.id = sub.holder_id) AS title
        FROM ${sources.subscriptionsOfSessions.from}
        WHERE ${named(sources.subscriptionsOfSessions)}
        UNION ALL
        SELECT rs.event_id AS event_id, sub.id AS subscription_id, sub.holder_kind AS holder_kind,
               sub.holder_id AS holder_id, sub.created_at AS created_at,
               (SELECT json_extract(runs.plan, '$.name') FROM runs WHERE runs.id = sub.holder_id)
                 AS title
        FROM ${sources.subscriptionsOfRuns.from}
        WHERE ${named(sources.subscriptionsOfRuns)}
      )
      GROUP BY event_id, subscription_id
      ORDER BY created_at, subscription_id
    `;

    const signals = groupByEvent(signalRows, (row): EventSignalFact => ({
      signalId: uuidToString(row.signal_id),
      kind: row.kind,
      status: row.status,
      title: row.title,
      ...(row.snoozed_until === null ? {} : { snoozedUntil: row.snoozed_until }),
      ...(row.outcome === null ? {} : { outcome: row.outcome }),
    }));
    const resolvedSignals = groupByEvent(resolvedRows, (row): EventResolvedSignalFact => ({
      signalId: uuidToString(row.signal_id),
      kind: row.kind,
      title: row.title,
      outcome: row.outcome,
    }));
    const tasks = groupByEvent(taskRows, (row): EventTaskFact => ({
      taskId: uuidToString(row.task_id),
      title: row.title,
    }));
    const knownBy = groupByEvent(knownByRows, (row): EventKnownByFact => ({
      subscriptionId: uuidToString(row.subscription_id),
      holder: { kind: row.holder_kind, id: uuidToString(row.holder_id) },
      title: row.title,
    }));

    return new Map(
      ids.map((id) => [
        id,
        {
          signals: signals.get(id) ?? [],
          resolvedSignals: resolvedSignals.get(id) ?? [],
          tasks: tasks.get(id) ?? [],
          knownBy: knownBy.get(id) ?? [],
        },
      ]),
    );
  });
