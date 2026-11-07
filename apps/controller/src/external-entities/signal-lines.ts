/**
 * The signals that live inside an External Entity: which signals a card or a
 * detail shows, the sentence a card says for its latest signal, and the SQL
 * that decides what a signal means for the Inbox and for retention.
 *
 * A signal and an entity meet by exact equality of `signals.thread_ref` and
 * `external_entities.ref`, on read. Nothing is stored on either side. Only
 * signals raised from an event have a thread ref (an API signal stores null),
 * so only those can join.
 *
 * There are two ideas of "has a signal", and they differ on purpose:
 *
 * - A card is on the Inbox while it holds an open signal that is not snoozed
 *   now (`buildLiveSignalExists`). A snooze ends with time, so every read
 *   takes `now` and nothing is written when a snooze runs out.
 * - A thing is kept and read while it holds any open signal, snoozed or not
 *   (`OPEN_SIGNAL_REFS_SQL`). A snoozed signal still needs its card.
 *
 * This module reads the `signals` and `signal_snoozes` tables directly. It
 * does not use the signals domain's repository, because that one reads whole
 * signals, one view at a time, and a card needs a line per signal for a
 * whole page in one statement.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  MAX_ENTITY_SIGNALS,
  type EntityReason,
  type EntitySignalLine,
  type SignalStatus,
  type TaskPriority,
} from "@hercule/contract";
import { uuidToString } from "../db";
import { parseReasonTemplates, renderSentence } from "./sentences";

/**
 * The refs of every open signal, snoozed ones too, as a `SELECT` of one `ref`
 * column. A thing with an open signal is kept by the sweep and wanted by
 * the refresh, so a snoozed signal never loses its card.
 */
export const OPEN_SIGNAL_REFS_SQL = `
  SELECT thread_ref AS ref FROM signals WHERE status = 'open' AND thread_ref IS NOT NULL`;

/**
 * The refs of the open signals that join a full record of a work kind (a
 * thing that can have a card), snoozed ones too. A signal on a place, a
 * partial record or a ref nobody has read is not here: it stays on its own.
 */
export const OPEN_SIGNAL_ENTITY_REFS_SQL = `
  SELECT s.thread_ref AS ref
  FROM signals s JOIN external_entities e ON e.ref = s.thread_ref
  WHERE s.status = 'open' AND e.completeness = 'full' AND e.pace IN ('fast', 'slow')`;

/**
 * The signals `s` with their snooze `z`, the rows every question about live
 * signals starts from. A signal without a snooze has no `z` row.
 */
const SIGNALS_WITH_SNOOZES_SQL = `signals s LEFT JOIN signal_snoozes z ON z.signal_id = s.id`;

/**
 * The SQL condition that an open signal `s` is live: it has no snooze, or its
 * snooze has ended. The Inbox's membership, the cards' newest signal and every
 * count of live signals use this one condition, so they cannot disagree. The
 * statement it sits in must define a `read_clock(now)` table with the time of
 * the read, because a snooze ends with time and nothing is written when it
 * does. Write `s.status = 'open'` beside it so SQLite seeks the index on
 * status.
 */
const LIVE_SIGNAL_CONDITION_SQL = `(z.until IS NULL OR z.until <= (SELECT now FROM read_clock))`;

/**
 * Builds the SQL condition that the entity row `entityAlias` holds an open
 * signal that is not snoozed now. The statement it sits in must define a
 * `read_clock(now)` table with the time of the read.
 */
export const buildLiveSignalExists = (entityAlias: string): string => `
  EXISTS (
    SELECT 1 FROM ${SIGNALS_WITH_SNOOZES_SQL}
    WHERE s.thread_ref = ${entityAlias}.ref AND s.status = 'open'
      AND ${LIVE_SIGNAL_CONDITION_SQL})`;

/** The newest live signal of a ref, with how many live signals it has. */
interface CardSignals {
  readonly latest?: EntitySignalLine;
  readonly openCount: number;
}

/** What a card holds when it has no live signal. */
const NO_CARD_SIGNALS: CardSignals = { openCount: 0 };

/** What the detail of one entity shows of its signals. */
interface DetailSignals {
  /** At most `MAX_ENTITY_SIGNALS` lines, oldest first by `createdAt`, then `id`. */
  readonly signals: ReadonlyArray<EntitySignalLine>;
  /** The open signals, snoozed ones included. */
  readonly openCount: number;
  /** Every signal on the ref, open and resolved. */
  readonly signalCount: number;
}

interface CardSignalRow {
  readonly ref: string;
  readonly id: Uint8Array;
  readonly kind: string;
  readonly title: string;
  readonly asker: string | null;
  readonly priority: string;
  readonly created_at: string;
  readonly open_count: number;
}

interface DetailSignalRow {
  readonly id: Uint8Array;
  readonly kind: string;
  readonly title: string;
  readonly asker: string | null;
  readonly priority: string;
  readonly status: string;
  readonly created_at: string;
  readonly outcome: string | null;
  readonly snooze_until: string | null;
}

const buildSignalLine = (
  row: Omit<DetailSignalRow, "snooze_until">,
  snoozed: boolean,
  reasonTemplates: string | null,
): EntitySignalLine => ({
  id: uuidToString(row.id),
  kind: row.kind,
  title: row.title,
  ...(row.asker === null ? {} : { asker: row.asker }),
  priority: row.priority as TaskPriority,
  status: row.status as SignalStatus,
  createdAt: row.created_at,
  say: buildSignalSay(
    { kind: row.kind, title: row.title, asker: row.asker ?? undefined },
    reasonTemplates,
  ),
  ...(row.outcome === null ? {} : { outcome: row.outcome }),
  snoozed,
});

/**
 * Builds the sentence a card says for one signal. The Inbox card's `reason`
 * and every line of a card's detail use this one function.
 *
 * The kind's own words come from `reasonTemplates`, the JSON copy of the
 * kind's `reasons` table that the entity stores, under the signal kind's word
 * (the part after `<plugin>/`, so `github/review-requested` looks up
 * `review-requested`). `{person}` is the signal's asker. The signal's title is
 * the fallback, with the `plain` tone, when:
 *
 * - the signal kind is a core kind, which has no plugin word;
 * - the entity stores no template under the word;
 * - the template needs a person and the signal has no asker, or it names
 *   anything else, which a signal cannot supply.
 *
 * Filling, cutting and falling back are done by `renderSentence`, as for the
 * words of a timeline.
 */
export const buildSignalSay = (
  signal: { readonly kind: string; readonly title: string; readonly asker: string | undefined },
  reasonTemplates: string | null,
): EntityReason => {
  const slash = signal.kind.indexOf("/");
  const template =
    slash < 0 ? undefined : parseReasonTemplates(reasonTemplates)?.[signal.kind.slice(slash + 1)];
  return renderSentence(template, { person: signal.asker }, signal.title);
};

/**
 * Builds the two fields of an Inbox card that come from its signals: the
 * `signals` summary, and, when the card has a live signal, the `reason` that
 * replaces the observation's own: the sentence of its latest signal. A card
 * with no live signal gets no `reason` here, so it keeps the one its
 * observation gave.
 */
export const buildCardSignalFields = (
  found: CardSignals | undefined,
): { readonly signals: CardSignals; readonly reason?: EntityReason } => {
  const signals = found ?? NO_CARD_SIGNALS;
  return signals.latest === undefined ? { signals } : { signals, reason: signals.latest.say };
};

/**
 * Builds the reads of the signals of entities over `sql`. Every method is one
 * statement however many refs it is given, and checks no grant.
 */
export const makeSignalLineReads = (sql: SqlClient.SqlClient) => {
  const refsJson = (refs: ReadonlyArray<string>): string => JSON.stringify(refs);

  return {
    /**
     * Returns, for each of `entities` that holds a live signal (open and not
     * snoozed at `now`), its newest one and how many there are. A line says
     * its sentence with the entity's `reasonTemplates`. The newest is
     * by `createdAt`, then by id. A ref with no live signal is left out. One
     * statement for the whole page of cards.
     */
    readCardSignals: (
      entities: ReadonlyArray<{ readonly ref: string; readonly reasonTemplates: string | null }>,
      now: string,
    ): Effect.Effect<ReadonlyMap<string, CardSignals>, SqlError> =>
      entities.length === 0
        ? Effect.succeed(new Map())
        : Effect.map(
            sql<CardSignalRow>`
              WITH read_clock(now) AS (SELECT ${now}),
              live AS (
                SELECT s.thread_ref AS ref, s.id, s.kind, s.title, s.asker, s.priority, s.created_at,
                  COUNT(*) OVER (PARTITION BY s.thread_ref) AS open_count,
                  ROW_NUMBER() OVER (
                    PARTITION BY s.thread_ref ORDER BY s.created_at DESC, s.id DESC) AS newest
                FROM ${sql.literal(SIGNALS_WITH_SNOOZES_SQL)}
                WHERE s.status = 'open'
                  AND s.thread_ref IN (SELECT value FROM json_each(${refsJson(entities.map((entity) => entity.ref))}))
                  AND ${sql.literal(LIVE_SIGNAL_CONDITION_SQL)})
              SELECT ref, id, kind, title, asker, priority, created_at, open_count
              FROM live WHERE newest = 1`,
            (rows) => {
              const templates = new Map(
                entities.map((entity) => [entity.ref, entity.reasonTemplates]),
              );
              return new Map(
                rows.map((row): [string, CardSignals] => [
                  row.ref,
                  {
                    latest: buildSignalLine(
                      { ...row, status: "open", outcome: null },
                      false,
                      templates.get(row.ref) ?? null,
                    ),
                    openCount: row.open_count,
                  },
                ]),
              );
            },
          ),

    /**
     * Returns how many live signals (open, not snoozed at `now`) each of
     * `refs` holds, for the refs that hold any. One statement.
     */
    countLiveSignals: (
      refs: ReadonlyArray<string>,
      now: string,
    ): Effect.Effect<ReadonlyMap<string, number>, SqlError> =>
      refs.length === 0
        ? Effect.succeed(new Map())
        : Effect.map(
            sql<{ readonly ref: string; readonly live: number }>`
              WITH read_clock(now) AS (SELECT ${now})
              SELECT s.thread_ref AS ref, COUNT(*) AS live
              FROM ${sql.literal(SIGNALS_WITH_SNOOZES_SQL)}
              WHERE s.status = 'open'
                AND s.thread_ref IN (SELECT value FROM json_each(${refsJson(refs)}))
                AND ${sql.literal(LIVE_SIGNAL_CONDITION_SQL)}
              GROUP BY s.thread_ref`,
            (rows) => new Map(rows.map((row) => [row.ref, row.live])),
          ),

    /**
     * Returns the ids of the open signals (snoozed ones too) whose thread ref
     * is one of `refs`, sorted. One statement, none for no refs.
     */
    listOpenSignalIds: (
      refs: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      refs.length === 0
        ? Effect.succeed([])
        : Effect.map(
            sql<{ readonly id: Uint8Array }>`
              SELECT id FROM signals
              WHERE status = 'open'
                AND thread_ref IN (SELECT value FROM json_each(${refsJson(refs)}))`,
            (rows) => rows.map((row) => uuidToString(row.id)).sort(),
          ),

    /**
     * Returns the signals the detail of the entity at `ref` shows, with the
     * counts. At most `MAX_ENTITY_SIGNALS` lines: the newest open signals
     * first (snoozed ones included, marked), then the newest resolved ones in
     * whatever room is left. The selected lines are returned oldest first, by
     * `createdAt`, then by id.
     *
     * Three statements, all served by the index `signals_thread_ref`, so the
     * work is bounded by the limit however many signals the ref has: the two
     * counts, the open lines, and the resolved lines (not read when the open
     * ones fill the room).
     */
    readDetailSignals: (
      ref: string,
      reasonTemplates: string | null,
      now: string,
    ): Effect.Effect<DetailSignals, SqlError> =>
      Effect.gen(function* () {
        const counts = yield* sql<{ readonly status: string; readonly total: number }>`
          SELECT status, COUNT(*) AS total FROM signals
          WHERE thread_ref = ${ref} GROUP BY status`;
        const openCount = counts.find((row) => row.status === "open")?.total ?? 0;
        const signalCount = counts.reduce((sum, row) => sum + row.total, 0);
        const open =
          openCount === 0
            ? []
            : yield* sql<DetailSignalRow>`
              SELECT s.id, s.kind, s.title, s.asker, s.priority, s.status, s.created_at,
                NULL AS outcome, z.until AS snooze_until
              FROM ${sql.literal(SIGNALS_WITH_SNOOZES_SQL)}
              WHERE s.thread_ref = ${ref} AND s.status = 'open'
              ORDER BY s.created_at DESC, s.id DESC LIMIT ${MAX_ENTITY_SIGNALS}`;
        const room = MAX_ENTITY_SIGNALS - open.length;
        const resolved =
          room <= 0 || signalCount === openCount
            ? []
            : yield* sql<DetailSignalRow>`
              SELECT id, kind, title, asker, priority, status, created_at,
                json_extract(resolution, '$.outcome') AS outcome, NULL AS snooze_until
              FROM signals
              WHERE thread_ref = ${ref} AND status = 'resolved'
              ORDER BY created_at DESC, id DESC LIMIT ${room}`;
        // The ids are lowercase hex, so comparing them as text orders them as SQLite orders the bytes.
        const lines = [...open, ...resolved]
          .map((row) => ({ row, id: uuidToString(row.id) }))
          .sort(
            (a, b) =>
              (a.row.created_at < b.row.created_at
                ? -1
                : a.row.created_at > b.row.created_at
                  ? 1
                  : 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
          )
          .map(({ row }) => row);
        return {
          signals: lines.map((row) =>
            buildSignalLine(
              row,
              row.snooze_until !== null && row.snooze_until > now,
              reasonTemplates,
            ),
          ),
          openCount,
          signalCount,
        };
      }),
  };
};
