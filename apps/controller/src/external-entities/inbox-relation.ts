/**
 * The Inbox relation: the one place that says what the Inbox is, as SQL.
 *
 * Every read of the Inbox starts from the same common table expressions, and
 * every one of them is built here, with its bound values beside its text:
 *
 * - `live_links`, `taken`, `live_signals`, `asks` and `ask_summary` say what a
 *   thing asks (`buildAskTables`);
 * - `eligible` is the things on the Inbox, one row per entity, carrying
 *   `task_id`, `ask_count`, `oldest_ask` and `newest_ask`
 *   (`buildEligibleEntities`);
 * - `matched` is the eligible things that pass a filter, with the columns
 *   `ref`, `id`, `kind`, `task_id`, `oldest_ask`, `upd` (the source's update
 *   time) and `grp` (0 for a thing that asks, 1 for the rest)
 *   (`buildMatchedEntities`). The order of a page and its keyset read those
 *   columns, so they are here too.
 *
 * The core keys of a query (`CORE_KEYS`) are here as well: one entry per key
 * holds both what the key filters and which values it offers, so a core key
 * changes in one place.
 *
 * Everything is composed from `CompiledSql` fragments, which carry their
 * `?` placeholders and their values together, so no caller has to know in what
 * order a statement binds its values. A value from a caller is always bound,
 * never written into the text.
 */
import {
  CORE_INBOX_FIELDS,
  type ClauseValue,
  type CoreInboxFieldKey,
  type EntityFieldType,
  type InboxClauseOperator,
} from "@hercule/plugin-host";
import { uuidFromString } from "../db";
import { buildLiveTaskLinksSql } from "../tasks";
import { buildWorkRecordCondition } from "./entity-records";

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

/** A value bound to a `?` of a compiled expression. */
export type SqlValue = string | number | Uint8Array;

/** A SQL expression and the values its `?` placeholders take, in order. */
export interface CompiledSql {
  readonly sql: string;
  readonly params: ReadonlyArray<SqlValue>;
}

/**
 * Joins boolean expressions with `AND` or `OR`, each in parentheses, and their
 * values in order. A part that is always true (`1`) leaves an `AND` out, a part
 * that is always false (`0`) leaves an `OR` out, and the opposite part decides
 * the whole.
 */
export const joinConditions = (
  operator: "AND" | "OR",
  parts: ReadonlyArray<CompiledSql>,
): CompiledSql => {
  const neutral = operator === "AND" ? "1" : "0";
  const decisive = operator === "AND" ? "0" : "1";
  if (parts.some((part) => part.sql === decisive)) return { sql: decisive, params: [] };
  const kept = parts.filter((part) => part.sql !== neutral);
  if (kept.length === 0) return { sql: neutral, params: [] };
  if (kept.length === 1) return kept[0]!;
  return {
    sql: kept.map((part) => `(${part.sql})`).join(` ${operator} `),
    params: kept.flatMap((part) => part.params),
  };
};

/** Joins the common table expressions of a `WITH`, in the order given, with their values. */
const joinTables = (parts: ReadonlyArray<CompiledSql>): CompiledSql => ({
  sql: parts.map((part) => part.sql).join(",\n  "),
  params: parts.flatMap((part) => part.params),
});

/** Wraps SQL text that binds no value. */
const plain = (sql: string): CompiledSql => ({ sql, params: [] });

// ---------------------------------------------------------------------------
// Names every read of the Inbox shares
// ---------------------------------------------------------------------------

/** The SQL of the plugin id of the row `alias`: what its `kind` has before the slash. */
export const buildSourceOfKindSql = (alias: string): string =>
  `substr(${alias}.kind, 1, instr(${alias}.kind, '/') - 1)`;

/** Returns the plugin id a qualified kind starts with. */
export const parseSourceOfKind = (kind: string): string => kind.slice(0, kind.indexOf("/"));

/** Matches the text form of a UUID: an id that is not one matches no Connection. */
export const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The condition that the observation row `o` is a Connection observing its
 * thing: it can read it now, or it reports a concern for it. A Connection that
 * only tried and was refused does not observe it.
 */
export const OBSERVING_SQL = `(o.access = 'ok' OR o.concerns <> '[]')`;

/**
 * Some Connection reads the record `t` now: the readability rule for a title
 * that belongs to another record, which is restricted data otherwise.
 */
export const READABLE_RECORD_SQL = `EXISTS (SELECT 1 FROM external_entity_observations o WHERE o.ref = t.ref AND o.access = 'ok')`;

/**
 * The refs that concern the user: some Connection's inventory reports a
 * concern for them. Every question about who is on the Inbox starts from this
 * one query, so a thing that is on the Inbox is also kept, read and suggested.
 *
 * Open signals are not in it. They answer each question their own way (see
 * `inbox-population.ts`).
 */
export const CONCERNED_REFS_SQL = `SELECT ref FROM external_entity_observations WHERE concerns <> '[]'`;

// ---------------------------------------------------------------------------
// What is on the Inbox
// ---------------------------------------------------------------------------

/**
 * What decides who is on the Inbox at one moment: the read clock, which says
 * which snoozes have ended, and the signal kinds that ask the user for a move.
 * The asking kinds come from `listAskingKinds`, the one place that decides
 * which kinds ask.
 */
export interface InboxMembership {
  readonly now: string;
  readonly askingKinds: ReadonlyArray<string>;
}

/**
 * Builds the common table expressions that say what a thing asks, the one
 * definition of "live", "taken" and "asking", shared by the reads of the whole
 * Inbox and the read of one page's asks. As a list to put after `WITH`:
 *
 * - `read_clock`: the read clock `now`.
 * - `page_refs` (only with `onlyRefs`): the refs the read is limited to.
 * - `live_links`: the live Task links, each ref's active Task at `position =
 *   1`.
 * - `taken`: for each ref whose active Task the user took on, when that
 *   happened. It reads `task_entity_links.taken_at`. Only Take on and Add to
 *   Work set it, on the Task they make and on a Task something else made (a
 *   hand-off, a signal, an event, a session, a workflow action). Those other
 *   ways never set it themselves.
 * - `live_signals`: the open signals that are not snoozed at `now`, each
 *   marked `asking` when its kind asks.
 * - `asks`: the live signals of an asking kind that nobody took. An ask is
 *   taken when the user took the thing on after it was raised, so it stays
 *   out of the list until a newer one arrives.
 * - `ask_summary`: per ref, how many asks, and when the oldest and the newest
 *   were raised.
 *
 * With `onlyRefs`, only the links and signals of those refs are read, so the
 * cost follows the refs and not the whole Inbox. The answers for those refs
 * are the same as without it.
 */
const buildAskTables = (
  membership: InboxMembership,
  onlyRefs: ReadonlyArray<string> | undefined,
): ReadonlyArray<CompiledSql> => [
  { sql: "read_clock(now) AS (SELECT ?)", params: [membership.now] },
  ...(onlyRefs === undefined
    ? []
    : [
        {
          sql: "page_refs(ref) AS (SELECT value FROM json_each(?))",
          params: [JSON.stringify(onlyRefs)],
        },
      ]),
  plain(
    `live_links AS MATERIALIZED (${buildLiveTaskLinksSql(onlyRefs === undefined ? "1" : "l.ref IN (SELECT ref FROM page_refs)")})`,
  ),
  plain(TAKEN_SQL),
  {
    sql: `live_signals AS MATERIALIZED (
    SELECT s.thread_ref AS ref, s.id, s.kind, s.asker, s.created_at,
      s.kind IN (SELECT value FROM json_each(?)) AS asking
    FROM signals s LEFT JOIN signal_snoozes z ON z.signal_id = s.id
    WHERE s.status = 'open' AND s.thread_ref IS NOT NULL
      AND ${onlyRefs === undefined ? "" : "s.thread_ref IN (SELECT ref FROM page_refs) AND"}
      (z.until IS NULL OR z.until <= (SELECT now FROM read_clock)))`,
    params: [JSON.stringify(membership.askingKinds)],
  },
  plain(`asks AS MATERIALIZED (
    SELECT ls.ref, ls.id, ls.kind, ls.asker, ls.created_at
    FROM live_signals ls LEFT JOIN taken t ON t.ref = ls.ref
    WHERE ls.asking = 1 AND (t.taken_at IS NULL OR ls.created_at >= t.taken_at))`),
  plain(`ask_summary AS MATERIALIZED (
    SELECT ref, COUNT(*) AS ask_count, MIN(created_at) AS oldest_ask, MAX(created_at) AS newest_ask
    FROM asks GROUP BY ref)`),
];

/** The `taken` table of `buildAskTables`. It reads the `live_links` table. */
const TAKEN_SQL = `taken AS MATERIALIZED (
    SELECT l.ref, l.taken_at FROM live_links l
    WHERE l.position = 1 AND l.taken_at IS NOT NULL)`;

/**
 * Builds the common table expressions of the eligible entities, to put after
 * `WITH`: `buildAskTables` over every ref (or the `onlyRefs`), and
 *
 * - `eligible`: the entities on the Inbox. A full record of a work kind that
 *   concerns the user, has a live Task or holds a live signal; and is not
 *   dismissed, or has an ask raised after the dismissal. Access, lifecycle,
 *   stale and whether the kind is still declared do not matter: a thing keeps
 *   its last known facts. It carries the active Task (`task_id`) and the
 *   summary of its asks (`ask_count`, `oldest_ask`, `newest_ask`, null for no
 *   asks).
 *
 * With `onlyRefs`, only those refs are looked at, so a read of some things
 * does not rank the whole Inbox. A ref is eligible or not the same way either
 * way.
 */
export const buildEligibleEntities = (
  membership: InboxMembership,
  onlyRefs?: ReadonlyArray<string>,
): CompiledSql =>
  joinTables([
    ...buildAskTables(membership, onlyRefs),
    plain(`eligible AS (
    SELECT e.*, l.task_id AS task_id, a.ask_count, a.oldest_ask, a.newest_ask
    FROM external_entities e
    LEFT JOIN live_links l ON l.ref = e.ref AND l.position = 1
    LEFT JOIN ask_summary a ON a.ref = e.ref
    WHERE ${buildWorkRecordCondition("e")}
      ${onlyRefs === undefined ? "" : "AND e.ref IN (SELECT ref FROM page_refs)"}
      AND (e.dismissed_at IS NULL OR a.newest_ask > e.dismissed_at)
      AND (e.ref IN (${CONCERNED_REFS_SQL}) OR l.task_id IS NOT NULL
           OR e.ref IN (SELECT ref FROM live_signals)))`),
  ]);

/**
 * Builds the tables `live_links` and `taken` for the refs of one page only, to
 * put after `WITH`. `taken` means what it means in `buildAskTables`, and the
 * answer for these refs is the same as in `buildEligibleEntities`. The signals
 * are not read.
 */
export const buildTakenOfRefs = (refs: ReadonlyArray<string>): CompiledSql => ({
  sql: `live_links AS MATERIALIZED (${buildLiveTaskLinksSql("l.ref IN (SELECT value FROM json_each(?))")}),
  ${TAKEN_SQL}`,
  params: [JSON.stringify(refs)],
});

/**
 * Builds the tables `live_links`, `taken`, `live_signals`, `asks` and
 * `ask_summary` for the refs of one page only, to put after `WITH`. They mean
 * what they mean in `buildEligibleEntities`, but read only the links and
 * signals of `refs`, so a page's asks do not rebuild the Inbox's membership.
 */
export const buildAsksOfRefs = (
  refs: ReadonlyArray<string>,
  membership: InboxMembership,
): CompiledSql => joinTables(buildAskTables(membership, refs));

/**
 * Builds the common table expressions of a read: `buildEligibleEntities`, and
 * `matched`, the eligible things that pass `filter`. With `onlyRefs`, only
 * those things are looked at. `extra` is more tables to follow, written after a
 * comma.
 */
export const buildMatchedEntities = (
  membership: InboxMembership,
  filter: CompiledSql,
  extra: CompiledSql = plain(""),
  onlyRefs?: ReadonlyArray<string>,
): CompiledSql => {
  const eligible = buildEligibleEntities(membership, onlyRefs);
  return {
    sql: `${eligible.sql},
      matched AS MATERIALIZED (
        SELECT e.ref, e.id, e.kind, e.task_id, e.oldest_ask, e.source_updated_at AS upd,
          CASE WHEN e.oldest_ask IS NULL THEN 1 ELSE 0 END AS grp
        FROM eligible e WHERE ${filter.sql})${extra.sql}`,
    params: [...eligible.params, ...filter.params, ...extra.params],
  };
};

/** The sort key of a thing in a list, which a cursor carries. */
export type SortTuple = ReadonlyArray<string | number>;

/** How a list is ordered. */
export type InboxListOrder = "waiting" | "newest";

/**
 * Builds the `WHERE` that keeps the things of `matched` (alias `m`) after the
 * sort tuple. Order `waiting` sorts things with an ask first, oldest ask first
 * (`grp = 0`), then the rest by the latest change; order `newest` by the latest
 * change. Ties break by ref.
 */
export const buildKeyset = (order: InboxListOrder, tuple: SortTuple | undefined): CompiledSql => {
  if (tuple === undefined) return plain("1");
  if (order === "newest") {
    const [upd, ref] = tuple as [string, string];
    return { sql: "(m.upd < ? OR (m.upd = ? AND m.ref > ?))", params: [upd, upd, ref] };
  }
  const [grp, key, ref] = tuple as [number, string, string];
  return grp === 0
    ? {
        sql: "((m.grp = 0 AND (m.oldest_ask > ? OR (m.oldest_ask = ? AND m.ref > ?))) OR m.grp = 1)",
        params: [key, key, ref],
      }
    : {
        sql: "(m.grp = 1 AND (m.upd < ? OR (m.upd = ? AND m.ref > ?)))",
        params: [key, key, ref],
      };
};

/** The `ORDER BY` of `matched` (alias `m`) for each order, consistent with `buildKeyset`. */
export const ORDER_BY: Readonly<Record<InboxListOrder, string>> = {
  waiting:
    "m.grp ASC, CASE WHEN m.grp = 0 THEN m.oldest_ask END ASC, CASE WHEN m.grp = 1 THEN m.upd END DESC, m.ref ASC",
  newest: "m.upd DESC, m.ref ASC",
};

/** Builds the sort tuple of a row of `matched`, which a cursor carries to continue after it. */
export const buildSortTuple = (
  order: InboxListOrder,
  row: {
    readonly upd: string;
    readonly ref: string;
    readonly grp: number;
    readonly oldest_ask: string | null;
  },
): SortTuple =>
  order === "newest"
    ? [row.upd, row.ref]
    : [row.grp, row.grp === 0 ? row.oldest_ask! : row.upd, row.ref];

// ---------------------------------------------------------------------------
// The core keys
// ---------------------------------------------------------------------------

/** What a core key's filter needs besides the value: the read clock and the signal kinds' nouns. */
export interface CoreKeyContext {
  readonly now: string;
  /** The signal kinds of the active plugins: a `signal` clause matches a kind's noun. */
  readonly signalKinds: ReadonlyArray<{ readonly kind: string; readonly noun: string }>;
}

/**
 * One core key of a query (`CORE_INBOX_FIELDS`): what it filters, and which
 * values it offers to the search.
 *
 * - `filter` returns the condition on one row of `eligible` (alias `e`) for a
 *   clause whose value has been read for the key's type, or a sentence saying
 *   why the clause cannot be answered.
 * - `values` is the SQL of the values the key offers among the things of
 *   `matched`, as rows of `value`, `label`, `source` and `ref`. Absent for a
 *   key with no values to suggest (a boolean or a duration).
 */
interface CoreKey {
  readonly filter: (
    value: ClauseValue,
    op: InboxClauseOperator,
    context: CoreKeyContext,
  ) => CompiledSql | string;
  readonly values?: string;
}

/** Returns an ISO time `seconds` before `now`, or undefined when that is not a time. */
const computeTimeBefore = (now: string, seconds: number): string | undefined => {
  const moment = new Date(Date.parse(now) - seconds * 1000);
  return Number.isNaN(moment.getTime()) ? undefined : moment.toISOString();
};

const matchedSourceSql = buildSourceOfKindSql("m");

/** Builds the filter of a boolean key: true needs the condition to hold, false that it does not. */
const buildBooleanFilter =
  (condition: string): CoreKey["filter"] =>
  (value) => ({ sql: value === true ? condition : `NOT (${condition})`, params: [] });

/**
 * The core keys, one entry each. The type of `CORE_KEYS` makes it a compile
 * error to add a key to `CORE_INBOX_FIELDS` without writing its entry here.
 */
export const CORE_KEYS: Readonly<Record<CoreInboxFieldKey, CoreKey>> = {
  source: {
    filter: (value) => ({
      sql: `${buildSourceOfKindSql("e")} = ? COLLATE NOCASE`,
      params: [String(value)],
    }),
    values: `SELECT ${matchedSourceSql} AS value, ${matchedSourceSql} AS label, ${matchedSourceSql} AS source, m.ref AS ref FROM matched m`,
  },
  kind: {
    filter: (value) => ({
      sql: `(e.kind = ? OR e.noun = ? COLLATE NOCASE OR substr(e.kind, instr(e.kind, '/') + 1) = ? COLLATE NOCASE)`,
      params: [String(value), String(value), String(value)],
    }),
    values: `SELECT m.kind AS value, e.noun AS label, ${matchedSourceSql} AS source, m.ref AS ref
      FROM matched m JOIN external_entities e ON e.ref = m.ref`,
  },
  account: {
    filter: (value) => {
      const text = String(value);
      const byId = UUID_TEXT.test(text);
      return {
        sql: `EXISTS (SELECT 1 FROM external_entity_observations o JOIN connections c ON c.id = o.connection_id
          WHERE o.ref = e.ref AND ${OBSERVING_SQL}
            AND (${byId ? "c.id = ? OR " : ""}c.label = ? COLLATE NOCASE))`,
        params: byId ? [uuidFromString(text), text] : [text],
      };
    },
    values: `SELECT c.label AS value, c.label AS label, ${matchedSourceSql} AS source, m.ref AS ref
      FROM matched m JOIN external_entity_observations o ON o.ref = m.ref AND ${OBSERVING_SQL}
        JOIN connections c ON c.id = o.connection_id`,
  },
  from: {
    filter: (value) => ({
      sql: `(EXISTS (SELECT 1 FROM asks a WHERE a.ref = e.ref AND a.asker = ? COLLATE NOCASE)
          OR (e.ask_count IS NULL AND json_extract(e.person, '$.name') = ? COLLATE NOCASE))`,
      params: [String(value), String(value)],
    }),
    values: `SELECT a.asker AS value, a.asker AS label, ${matchedSourceSql} AS source, m.ref AS ref
      FROM matched m JOIN asks a ON a.ref = m.ref WHERE a.asker IS NOT NULL
      UNION
      SELECT json_extract(e.person, '$.name'), json_extract(e.person, '$.name'), ${matchedSourceSql}, m.ref
      FROM matched m JOIN external_entities e ON e.ref = m.ref
      WHERE m.oldest_ask IS NULL AND json_extract(e.person, '$.name') IS NOT NULL`,
  },
  waiting: {
    filter: (value, op, { now }) => {
      const cutoff = computeTimeBefore(now, Number(value));
      if (cutoff === undefined) return `waiting ${String(value)} is too long ago`;
      // The wait is the oldest open ask's, so waiting over N seconds means it began before the cutoff.
      return {
        sql:
          op === "over"
            ? `e.oldest_ask IS NOT NULL AND e.oldest_ask < ?`
            : `e.oldest_ask IS NOT NULL AND e.oldest_ask > ?`,
        params: [cutoff],
      };
    },
  },
  asks: { filter: buildBooleanFilter("e.ask_count IS NOT NULL") },
  held: { filter: buildBooleanFilter("e.task_id IS NOT NULL") },
  mine: {
    filter: buildBooleanFilter(
      "EXISTS (SELECT 1 FROM external_entity_observations o WHERE o.ref = e.ref AND o.owned_by_you = 1)",
    ),
  },
  signal: {
    filter: (value, _op, { signalKinds }) => {
      const text = String(value);
      const lowered = text.toLowerCase();
      const namedByNoun = signalKinds
        .filter((entry) => entry.noun.toLowerCase() === lowered)
        .map((entry) => entry.kind);
      return {
        sql: `EXISTS (SELECT 1 FROM live_signals s WHERE s.ref = e.ref
          AND (s.kind = ? OR substr(s.kind, instr(s.kind, '/') + 1) = ? COLLATE NOCASE
               OR s.kind IN (SELECT value FROM json_each(?))))`,
        params: [text, text, JSON.stringify(namedByNoun)],
      };
    },
    values: `SELECT s.kind AS value, s.kind AS label, ${matchedSourceSql} AS source, m.ref AS ref
      FROM matched m JOIN live_signals s ON s.ref = m.ref`,
  },
};

/** Returns the type of a core key's value, such as `age` for `waiting`. */
export const readCoreKeyType = (key: string): EntityFieldType | undefined =>
  CORE_INBOX_FIELDS.find((field) => field.key === key)?.type;

/** Checks whether `key` is one of the core keys. */
export const isCoreKey = (key: string): key is CoreInboxFieldKey => Object.hasOwn(CORE_KEYS, key);
