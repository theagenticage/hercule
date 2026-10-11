/**
 * Signal rows.
 *
 * This module reads and writes the contract's `Signal`. The origin, the
 * blocks, the actions, the match values, the task, the Ignore Rule and the
 * resolution are stored as JSON, because a signal is read and written whole.
 * The events a signal is about are also kept in `signal_events`, so a prune
 * of the event log can find them by index. A snooze is kept in
 * `signal_snoozes`, beside the signal rather than on it, and every read joins
 * it in. Nothing here decides policy; it only reads and writes.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type {
  Actor,
  Block,
  BoundAction,
  Signal,
  SignalMatch,
  SignalOrigin,
  SignalResolution,
  SignalStatus,
  TaskCreateInput,
  TaskPriority,
} from "@hercule/contract";
import {
  buildKeyset,
  buildPage,
  decodeCursor,
  encodeCursor,
  uuidFromString,
  uuidToString,
  type CursorError,
  type CursorScope,
  type Page,
} from "../db";

/** A signal as it is written. The caller mints the id, because the actions may name it. */
export type NewSignal = Omit<Signal, "snooze">;

interface SignalRow {
  readonly id: Uint8Array;
  readonly kind: string;
  readonly origin: string;
  readonly title: string;
  readonly asker: string | null;
  readonly place: string | null;
  readonly priority: string;
  readonly blocks: string;
  readonly actions: string;
  readonly match: string;
  readonly build_error: string | null;
  readonly task: string | null;
  readonly ignore_rule: string | null;
  readonly status: string;
  readonly resolution: string | null;
  readonly replaced_by: Uint8Array | null;
  readonly created_at: string;
  readonly snooze_until: string | null;
  readonly snoozed_at: string | null;
}

/** The kind and source filters every view of the signals takes. */
export interface SignalListFilter {
  readonly kind?: string;
  readonly source?: string;
}

/** The page size and cursor of a paged view. */
export interface SignalPageRequest {
  readonly limit: number;
  readonly cursor: string | undefined;
}

/**
 * The columns of a signal and of its snooze, if it has one, read from
 * `SIGNALS_WITH_SNOOZES`.
 */
const COLUMNS =
  "s.id, s.kind, s.origin, s.title, s.asker, s.place, s.priority, s.blocks, s.actions, s.match, s.build_error, s.task, s.ignore_rule, s.status, s.resolution, s.replaced_by, s.created_at, z.until AS snooze_until, z.snoozed_at";

/** The signals, each beside its snooze row, or beside nulls when it has none. */
const SIGNALS_WITH_SNOOZES = "signals s LEFT JOIN signal_snoozes z ON z.signal_id = s.id";

/** The Later view's order: soonest `until` first. */
const LATER_SCOPE: CursorScope = {
  op: "signal.query",
  sort: [{ field: "until", direction: "asc" }],
};

/** The Done view's order: newest resolution first. */
const DONE_SCOPE: CursorScope = {
  op: "signal.query",
  sort: [{ field: "resolvedAt", direction: "desc" }],
};

/** Converts a stored row into the contract's signal. */
const parseRow = (row: SignalRow): Signal => ({
  id: uuidToString(row.id),
  kind: row.kind,
  origin: JSON.parse(row.origin) as SignalOrigin,
  title: row.title,
  ...(row.asker === null ? {} : { asker: row.asker }),
  ...(row.place === null ? {} : { place: row.place }),
  priority: row.priority as TaskPriority,
  blocks: JSON.parse(row.blocks) as ReadonlyArray<Block>,
  actions: JSON.parse(row.actions) as ReadonlyArray<BoundAction>,
  match: JSON.parse(row.match) as SignalMatch,
  ...(row.build_error === null
    ? {}
    : { buildError: JSON.parse(row.build_error) as NonNullable<Signal["buildError"]> }),
  ...(row.task === null ? {} : { task: JSON.parse(row.task) as TaskCreateInput }),
  ...(row.ignore_rule === null
    ? {}
    : { ignoreRule: JSON.parse(row.ignore_rule) as NonNullable<Signal["ignoreRule"]> }),
  status: row.status as SignalStatus,
  ...(row.resolution === null
    ? {}
    : { resolution: JSON.parse(row.resolution) as SignalResolution }),
  ...(row.replaced_by === null ? {} : { replacedBy: uuidToString(row.replaced_by) }),
  createdAt: row.created_at,
  ...(row.snooze_until === null || row.snoozed_at === null
    ? {}
    : { snooze: { until: row.snooze_until, snoozedAt: row.snoozed_at } }),
});

/** Converts an optional value into a JSON column's value, or `null` when it is absent. */
const encodeOptionalJson = (value: unknown): string | null =>
  value === undefined ? null : JSON.stringify(value);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /** Builds the conditions for a view's `kind` and `source` filters. */
  const buildFilterClauses = (filter: SignalListFilter) => {
    const clauses = [];
    if (filter.kind !== undefined) clauses.push(sql`s.kind = ${filter.kind}`);
    // A plugin id holds no `%` or `_`, so the pattern matches only the prefix.
    if (filter.source !== undefined) clauses.push(sql`s.kind LIKE ${`${filter.source}/%`}`);
    return clauses;
  };

  /** Builds the condition that a signal's id is one of `ids`, which may be empty. */
  const buildIdIn = (column: string, ids: ReadonlyArray<string>) =>
    ids.length === 0
      ? sql`1 = 0`
      : sql`${sql.literal(column)} IN ${sql.in(ids.map(uuidFromString))}`;

  return {
    /**
     * Writes a new signal, and one `signal_events` row for each event its
     * origin names. `priorityLowered` records that the user already moved
     * the signal out of Now; a replacement passes on its predecessor's
     * choice this way.
     */
    insert: (
      signal: NewSignal,
      eventIds: ReadonlyArray<number>,
      options: { readonly priorityLowered?: boolean } = {},
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const id = uuidFromString(signal.id);
        yield* sql`
          INSERT INTO signals
            (id, kind, origin, title, asker, place, priority, blocks, actions, match, build_error,
             task, ignore_rule, status, resolution, replaced_by, created_at, priority_lowered)
          VALUES
            (${id}, ${signal.kind}, ${JSON.stringify(signal.origin)}, ${signal.title},
             ${signal.asker ?? null}, ${signal.place ?? null}, ${signal.priority},
             ${JSON.stringify(signal.blocks)}, ${JSON.stringify(signal.actions)},
             ${JSON.stringify(signal.match)}, ${encodeOptionalJson(signal.buildError)},
             ${encodeOptionalJson(signal.task)}, ${encodeOptionalJson(signal.ignoreRule)},
             ${signal.status}, ${encodeOptionalJson(signal.resolution)},
             ${signal.replacedBy === undefined ? null : uuidFromString(signal.replacedBy)},
             ${signal.createdAt}, ${options.priorityLowered === true ? 1 : 0})
        `;
        // A raiser may name one event twice; the table keeps each pair once.
        for (const eventId of new Set(eventIds)) {
          yield* sql`INSERT INTO signal_events (signal_id, event_id) VALUES (${id}, ${eventId})`;
        }
      }),

    /** Returns the signal with that id, or none if it does not exist. */
    read: (id: string): Effect.Effect<Option.Option<Signal>, SqlError> =>
      Effect.map(
        sql<SignalRow>`
          SELECT ${sql.literal(COLUMNS)} FROM ${sql.literal(SIGNALS_WITH_SNOOZES)}
          WHERE s.id = ${uuidFromString(id)}`,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), parseRow),
      ),

    /**
     * Returns the signals with these ids, in no particular order. An id with
     * no signal is left out, so the caller compares the lengths to find it.
     */
    readMany: (ids: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<Signal>, SqlError> =>
      Effect.map(
        sql<SignalRow>`
          SELECT ${sql.literal(COLUMNS)} FROM ${sql.literal(SIGNALS_WITH_SNOOZES)}
          WHERE ${buildIdIn("s.id", ids)}`,
        (rows) => rows.map(parseRow),
      ),

    /**
     * Checks whether the user moved the signal with that id out of Now. A
     * signal that does not exist was never lowered.
     */
    isPriorityLowered: (id: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly priority_lowered: number }>`
          SELECT priority_lowered FROM signals WHERE id = ${uuidFromString(id)}`,
        (rows) => rows[0]?.priority_lowered === 1,
      ),

    /**
     * Returns the kind and the title of the signal with that id, or none if
     * it does not exist. Starting a run and writing a describe line read only
     * these two, so they do not read the whole signal.
     */
    readKindAndTitle: (
      id: string,
    ): Effect.Effect<Option.Option<{ readonly kind: string; readonly title: string }>, SqlError> =>
      Effect.map(
        sql<{ readonly kind: string; readonly title: string }>`
          SELECT kind, title FROM signals WHERE id = ${uuidFromString(id)}`,
        (rows) => Option.fromNullishOr(rows[0]),
      ),

    /**
     * Returns the signals on To do at `now`: the open signals with no snooze,
     * or whose snooze ran out at or before `now`. The signals back from a
     * snooze come first, soonest `until` first, then the rest oldest first.
     * `kind` keeps the signals of one kind, and `source` the signals of one
     * plugin's kinds, whose kind starts with `<source>/`. The list is short,
     * so it is not paged.
     */
    listToDo: (
      filter: SignalListFilter,
      now: string,
    ): Effect.Effect<ReadonlyArray<Signal>, SqlError> =>
      Effect.map(
        sql<SignalRow>`
          SELECT ${sql.literal(COLUMNS)} FROM ${sql.literal(SIGNALS_WITH_SNOOZES)}
          WHERE ${sql.and([
            sql`s.status = 'open'`,
            sql`(z.until IS NULL OR z.until <= ${now})`,
            ...buildFilterClauses(filter),
          ])}
          ORDER BY z.until IS NULL, z.until, s.created_at, s.id
        `,
        (rows) => rows.map(parseRow),
      ),

    /**
     * Returns one page of the Later view at `now`: the signals snoozed until
     * after `now`, soonest first. Only an open signal has a snooze, because
     * resolving a signal deletes it. Fails with `CursorError` when the cursor
     * does not belong to this view.
     */
    listLater: (
      filter: SignalListFilter,
      request: SignalPageRequest,
      now: string,
    ): Effect.Effect<Page<Signal>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeCursor(request.cursor, LATER_SCOPE, ["string"]);
        const { keyset, order } = buildKeyset(
          sql,
          [{ column: "z.until", direction: "asc" }],
          ["z.signal_id"],
          after === undefined ? undefined : [...after.values, uuidFromString(after.id)],
        );
        const rows = yield* sql<SignalRow>`
          SELECT ${sql.literal(COLUMNS)}
          FROM signal_snoozes z JOIN signals s ON s.id = z.signal_id
          WHERE ${sql.and([sql`z.until > ${now}`, keyset, ...buildFilterClauses(filter)])}
          ${order} LIMIT ${request.limit + 1}
        `;
        return yield* buildPage(
          rows,
          request.limit,
          (page) => Effect.succeed(page.map(parseRow)),
          // Every row of this view has a snooze, joined from `signal_snoozes`.
          (last) => encodeCursor(LATER_SCOPE, [last.snooze!.until], last.id),
        );
      }),

    /**
     * Returns one page of the Done view: the resolved signals, newest
     * resolution first. Fails with `CursorError` when the cursor does not
     * belong to this view.
     */
    listDone: (
      filter: SignalListFilter,
      request: SignalPageRequest,
    ): Effect.Effect<Page<Signal>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeCursor(request.cursor, DONE_SCOPE, ["string"]);
        const { keyset, order } = buildKeyset(
          sql,
          [{ column: "s.resolved_at", direction: "desc" }],
          ["s.id"],
          after === undefined ? undefined : [...after.values, uuidFromString(after.id)],
        );
        const rows = yield* sql<SignalRow>`
          SELECT ${sql.literal(COLUMNS)} FROM ${sql.literal(SIGNALS_WITH_SNOOZES)}
          WHERE ${sql.and([sql`s.status = 'resolved'`, keyset, ...buildFilterClauses(filter)])}
          ${order} LIMIT ${request.limit + 1}
        `;
        return yield* buildPage(
          rows,
          request.limit,
          (page) => Effect.succeed(page.map(parseRow)),
          // A resolved signal has a resolution, and `resolved_at` is its `at`.
          (last) => encodeCursor(DONE_SCOPE, [last.resolution!.at], last.id),
        );
      }),

    /**
     * Resolves an open signal and deletes its snooze, so a snooze never
     * holds a resolved signal. Returns false, and writes nothing, when the
     * signal is not open, so two resolutions racing each other cannot both
     * win. Run it inside a transaction, so both writes commit together.
     */
    resolve: (id: string, resolution: SignalResolution): Effect.Effect<boolean, SqlError> =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly id: Uint8Array }>`
          UPDATE signals SET status = 'resolved', resolution = ${JSON.stringify(resolution)}
          WHERE id = ${uuidFromString(id)} AND status = 'open'
          RETURNING id
        `;
        if (rows.length === 0) return false;
        yield* sql`DELETE FROM signal_snoozes WHERE signal_id = ${uuidFromString(id)}`;
        return true;
      }),

    /**
     * Snoozes the signals with these ids until `until`, a UTC ISO time. A
     * signal that is already snoozed gets the new time, and the new
     * `snoozedAt` and actor. The caller passes only open signals.
     */
    snooze: (
      ids: ReadonlyArray<string>,
      snooze: { readonly until: string; readonly snoozedAt: string; readonly actor: Actor },
    ): Effect.Effect<void, SqlError> =>
      Effect.forEach(
        ids,
        (id) => sql`
          INSERT INTO signal_snoozes (signal_id, until, snoozed_at, actor)
          VALUES (${uuidFromString(id)}, ${snooze.until}, ${snooze.snoozedAt}, ${snooze.actor})
          ON CONFLICT (signal_id) DO UPDATE SET
            until = excluded.until, snoozed_at = excluded.snoozed_at, actor = excluded.actor
        `,
        { discard: true },
      ),

    /**
     * Deletes the snoozes of the signals with these ids, and returns the ids
     * of the signals that had one.
     */
    unsnooze: (ids: ReadonlyArray<string>): Effect.Effect<ReadonlySet<string>, SqlError> =>
      Effect.map(
        sql<{ readonly signal_id: Uint8Array }>`
          DELETE FROM signal_snoozes WHERE ${buildIdIn("signal_id", ids)}
          RETURNING signal_id
        `,
        (rows) => new Set(rows.map((row) => uuidToString(row.signal_id))),
      ),

    /**
     * Moves the open, `urgent` signals among these ids to `high`, marks them
     * lowered, and returns their ids. Every other signal is left as it is.
     */
    lowerPriority: (ids: ReadonlyArray<string>): Effect.Effect<ReadonlySet<string>, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          UPDATE signals SET priority = 'high', priority_lowered = 1
          WHERE ${buildIdIn("id", ids)} AND status = 'open' AND priority = 'urgent'
          RETURNING id
        `,
        (rows) => new Set(rows.map((row) => uuidToString(row.id))),
      ),
  };
});

/** Everything the signal service reads and writes. */
export const signalRepository = make;
