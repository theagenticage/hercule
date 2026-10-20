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
import type { Fragment } from "effect/unstable/sql/Statement";
import { DONE_ACTION_ID } from "@hercule/contract";
import type { OpenSignal } from "@hercule/plugin-host";
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

/** The fields of a signal that a handoff reads; see `readForHandOff`. */
export interface SignalForHandOff {
  readonly kind: string;
  readonly title: string;
  readonly place?: string;
  readonly priority: TaskPriority;
  readonly origin: SignalOrigin;
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

/**
 * Writes `match` as the JSON it is stored as: its fields sorted by name. Two
 * signals with the same values then store the same text whatever order their
 * values were built in, even after a plugin update reorders its kind's match
 * fields, so a group of signals is one indexed read of the `match` column.
 * An Ignore Rule's `match` is stored the same way.
 */
export const encodeSignalMatch = (match: SignalMatch): string =>
  JSON.stringify(Object.fromEntries(Object.entries(match).sort(([a], [b]) => (a < b ? -1 : 1))));

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

/** An open signal raised from an event, as the lookups by thread return it. */
interface OpenEventSignal {
  readonly id: string;
  /** The qualified kind, such as `github/review-requested`. */
  readonly kind: string;
  readonly threadRef: string;
  /** The id of the event the signal was raised from. */
  readonly eventId: number;
  readonly raisedAt: string;
}

interface OpenEventSignalRow {
  readonly id: Uint8Array;
  readonly kind: string;
  readonly thread_ref: string;
  readonly origin: string;
  readonly created_at: string;
}

/**
 * A signal the event router decided to raise, waiting for the step after the
 * commit to write it. `decision` is what the kind's rule returned: `yes`, or
 * `undecided` when no Screener has looked at it yet.
 */
export interface PendingRaise {
  readonly eventId: number;
  /** The qualified kind, such as `github/review-requested`. */
  readonly kind: string;
  readonly decision: "yes" | "undecided";
  readonly connectionId: string;
  readonly threadRef: string;
}

interface PendingRaiseRow {
  readonly event_id: number;
  readonly kind: string;
  readonly decision: "yes" | "undecided";
  readonly connection_id: Uint8Array;
  readonly thread_ref: string;
}

/**
 * Converts a row of the lookups by thread. Only a signal raised from an
 * event has a Connection and a thread, so its origin is always the `event`
 * origin.
 */
const parseOpenEventSignalRow = (row: OpenEventSignalRow): OpenEventSignal => {
  const origin = JSON.parse(row.origin) as Extract<SignalOrigin, { readonly type: "event" }>;
  return {
    id: uuidToString(row.id),
    kind: row.kind,
    threadRef: row.thread_ref,
    eventId: origin.eventId,
    raisedAt: row.created_at,
  };
};

/** Converts an optional value into a JSON column's value, or `null` when it is absent. */
const encodeOptionalJson = (value: unknown): string | null =>
  value === undefined ? null : JSON.stringify(value);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /** Builds the conditions for a view's `kind` and `source` filters. */
  const buildFilterClauses = (filter: SignalListFilter) => {
    const clauses = [];
    if (filter.kind !== undefined) clauses.push(sql`s.kind = ${filter.kind}`);
    // The kinds of one plugin are the kinds that start with `<source>/`. They
    // are selected as a range rather than with LIKE, because SQLite can seek
    // an index for a range. `0` is the character after `/`, so the range
    // ends right after the last kind with that prefix.
    if (filter.source !== undefined) {
      clauses.push(sql`s.kind >= ${`${filter.source}/`} AND s.kind < ${`${filter.source}0`}`);
    }
    return clauses;
  };

  /**
   * Returns one page of a paged view, ordered by `sortColumn` and then by
   * the signal's id, both in `direction`.
   *
   * - `scope` is the view's cursor scope, so a cursor from another view is
   *   refused with `CursorError`;
   * - `from` is the view's `FROM` clause, which names the signal `s` and its
   *   snooze `z`, and `idColumn` is the id column the view seeks on;
   * - `condition` keeps the view's rows;
   * - `readSortValue` returns a signal's value in `sortColumn`, for the next
   *   page's cursor.
   */
  const listPage = (view: {
    readonly scope: CursorScope;
    readonly from: string;
    readonly sortColumn: string;
    readonly idColumn: string;
    readonly direction: "asc" | "desc";
    readonly condition: Fragment;
    readonly filter: SignalListFilter;
    readonly request: SignalPageRequest;
    readonly readSortValue: (signal: Signal) => string;
  }): Effect.Effect<Page<Signal>, CursorError | SqlError> =>
    Effect.gen(function* () {
      const { request } = view;
      const after =
        request.cursor === undefined
          ? undefined
          : yield* decodeCursor(request.cursor, view.scope, ["string"]);
      const { keyset, order } = buildKeyset(
        sql,
        [{ column: view.sortColumn, direction: view.direction }],
        [view.idColumn],
        after === undefined ? undefined : [...after.values, uuidFromString(after.id)],
      );
      const rows = yield* sql<SignalRow>`
        SELECT ${sql.literal(COLUMNS)} FROM ${sql.literal(view.from)}
        WHERE ${sql.and([view.condition, keyset, ...buildFilterClauses(view.filter)])}
        ${order} LIMIT ${request.limit + 1}
      `;
      return yield* buildPage(
        rows,
        request.limit,
        (page) => Effect.succeed(page.map(parseRow)),
        (last) => encodeCursor(view.scope, [view.readSortValue(last)], last.id),
      );
    });

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
             task, ignore_rule, status, resolution, replaced_by, created_at, priority_lowered,
             connection_id, thread_ref)
          VALUES
            (${id}, ${signal.kind}, ${JSON.stringify(signal.origin)}, ${signal.title},
             ${signal.asker ?? null}, ${signal.place ?? null}, ${signal.priority},
             ${JSON.stringify(signal.blocks)}, ${JSON.stringify(signal.actions)},
             ${encodeSignalMatch(signal.match)}, ${encodeOptionalJson(signal.buildError)},
             ${encodeOptionalJson(signal.task)}, ${encodeOptionalJson(signal.ignoreRule)},
             ${signal.status}, ${encodeOptionalJson(signal.resolution)},
             ${signal.replacedBy === undefined ? null : uuidFromString(signal.replacedBy)},
             ${signal.createdAt}, ${options.priorityLowered === true ? 1 : 0},
             ${signal.origin.type === "event" ? uuidFromString(signal.origin.connectionId) : null},
             ${signal.origin.type === "event" ? signal.origin.threadRef : null})
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
     * Returns what a handoff of the signal with that id reads: its kind, title,
     * place, priority and origin, or none if it does not exist. It leaves out
     * the blocks and the actions, which are most of the row, because the
     * describe line of every Hand to an agent action on To do reads this.
     */
    readForHandOff: (id: string): Effect.Effect<Option.Option<SignalForHandOff>, SqlError> =>
      Effect.map(
        sql<{
          readonly kind: string;
          readonly title: string;
          readonly place: string | null;
          readonly priority: string;
          readonly origin: string;
        }>`
          SELECT kind, title, place, priority, origin FROM signals
          WHERE id = ${uuidFromString(id)}`,
        (rows) =>
          Option.map(Option.fromNullishOr(rows[0]), (row) => ({
            kind: row.kind,
            title: row.title,
            ...(row.place === null ? {} : { place: row.place }),
            priority: row.priority as TaskPriority,
            origin: JSON.parse(row.origin) as SignalOrigin,
          })),
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
      listPage({
        scope: LATER_SCOPE,
        from: "signal_snoozes z JOIN signals s ON s.id = z.signal_id",
        sortColumn: "z.until",
        idColumn: "z.signal_id",
        direction: "asc",
        condition: sql`z.until > ${now}`,
        filter,
        request,
        // Every row of this view has a snooze, joined from `signal_snoozes`.
        readSortValue: (signal) => signal.snooze!.until,
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
      listPage({
        scope: DONE_SCOPE,
        from: SIGNALS_WITH_SNOOZES,
        sortColumn: "s.resolved_at",
        idColumn: "s.id",
        direction: "desc",
        condition: sql`s.status = 'resolved'`,
        filter,
        request,
        // A resolved signal has a resolution, and `resolved_at` is its `at`.
        readSortValue: (signal) => signal.resolution!.at,
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
     * Resolves the open signals among these ids, all with one resolution,
     * deletes their snoozes, and returns the ids it resolved. A signal that
     * is not open is left as it is. Run it inside a transaction, so both
     * writes commit together.
     */
    resolveMany: (
      ids: ReadonlyArray<string>,
      resolution: SignalResolution,
    ): Effect.Effect<ReadonlySet<string>, SqlError> =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly id: Uint8Array }>`
          UPDATE signals SET status = 'resolved', resolution = ${JSON.stringify(resolution)}
          WHERE ${buildIdIn("id", ids)} AND status = 'open'
          RETURNING id
        `;
        const resolved = rows.map((row) => uuidToString(row.id));
        yield* sql`DELETE FROM signal_snoozes WHERE ${buildIdIn("signal_id", resolved)}`;
        return new Set(resolved);
      }),

    /**
     * Snoozes the signals with these ids until `until`, a UTC ISO time, in
     * one statement. A signal that is already snoozed gets the new time, and
     * the new `snoozedAt` and actor. The caller passes only open signals, at
     * least one.
     */
    snooze: (
      ids: ReadonlyArray<string>,
      snooze: { readonly until: string; readonly snoozedAt: string; readonly actor: Actor },
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        INSERT INTO signal_snoozes (signal_id, until, snoozed_at, actor)
        VALUES ${sql.csv(
          ids.map(
            (id) =>
              sql`(${uuidFromString(id)}, ${snooze.until}, ${snooze.snoozedAt}, ${snooze.actor})`,
          ),
        )}
        ON CONFLICT (signal_id) DO UPDATE SET
          until = excluded.until, snoozed_at = excluded.snoozed_at, actor = excluded.actor
      `),

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

    /**
     * Returns the open signals raised from the events of one Connection,
     * oldest first: each one's kind, thread, the dedup key and time of its
     * event, and the time it was raised. An event source reads them to know
     * which threads still wait on the user.
     *
     * The join on the event log drops no signal, because a prune of the log
     * keeps every event a signal names. The lookups by thread on the raise
     * path need no event fields, so they do not pay for the join.
     */
    listOpenOnConnection: (
      connectionId: string,
    ): Effect.Effect<ReadonlyArray<OpenSignal>, SqlError> =>
      Effect.map(
        sql<{
          readonly kind: string;
          readonly thread_ref: string;
          readonly dedup_key: string;
          readonly occurred_at: string;
          readonly created_at: string;
        }>`
          SELECT s.kind, s.thread_ref, e.dedup_key, e.occurred_at, s.created_at FROM signals s
          JOIN events e ON e.id = json_extract(s.origin, '$.eventId')
          WHERE s.status = 'open' AND s.connection_id = ${uuidFromString(connectionId)}
          ORDER BY s.created_at, s.id
        `,
        (rows) =>
          rows.map((row) => ({
            kind: row.kind,
            threadRef: row.thread_ref,
            event: { dedupKey: row.dedup_key, occurredAt: row.occurred_at },
            raisedAt: row.created_at,
          })),
      ),

    /**
     * Returns the open signals of one kind on one thread of a Connection,
     * oldest first. There is at most one in normal use, because a newer
     * signal on the thread replaces the older one.
     */
    listOpenOnThread: (
      connectionId: string,
      threadRef: string,
      kind: string,
    ): Effect.Effect<ReadonlyArray<OpenEventSignal>, SqlError> =>
      sql<OpenEventSignalRow>`
        SELECT id, kind, thread_ref, origin, created_at FROM signals
        WHERE status = 'open' AND connection_id = ${uuidFromString(connectionId)}
          AND thread_ref = ${threadRef} AND kind = ${kind}
        ORDER BY created_at, id
      `.pipe(Effect.map((rows) => rows.map(parseOpenEventSignalRow))),

    /**
     * Returns the id and match values of every open signal of `kind`.
     * Creating an Ignore Rule reads them to find the open signals the rule
     * takes off the list. The query reads the partial index
     * `signals_open_kind`, so it never reads the kind's resolved signals.
     */
    listOpenMatches: (
      kind: string,
    ): Effect.Effect<
      ReadonlyArray<{ readonly id: string; readonly match: SignalMatch }>,
      SqlError
    > =>
      Effect.map(
        sql<{ readonly id: Uint8Array; readonly match: string }>`
          SELECT id, match FROM signals WHERE kind = ${kind} AND status = 'open'
        `,
        (rows) =>
          rows.map((row) => ({
            id: uuidToString(row.id),
            match: JSON.parse(row.match) as SignalMatch,
          })),
      ),

    /**
     * Counts the Done streak of a group: the signals of `kind` with exactly
     * the values `match`. The count is the number of the group's newest
     * signals the user resolved with Done, back to the newest one that was
     * not: one still open, snoozed or not, or one answered another way, in
     * Hercule or on the source. Withdrawn signals are skipped, so they
     * neither count nor end the streak. Signals created at the same time are
     * ordered by id. Returns 0 when `match` is empty, because such a signal
     * is in no group.
     *
     * Both statements read the index `signals_group` newest first: the
     * first stops at the newest signal that ends the streak, and the second
     * reads only the signals after it.
     */
    countDoneStreak: (kind: string, match: SignalMatch): Effect.Effect<number, SqlError> =>
      Effect.gen(function* () {
        const stored = encodeSignalMatch(match);
        // `IS` rather than `=`, so a resolution with no `actionId`, as an end
        // on the source may write, counts as an answer that ends the streak.
        const breakers = yield* sql<{ readonly created_at: string; readonly id: Uint8Array }>`
          SELECT created_at, id FROM signals
          WHERE kind = ${kind} AND match = ${stored} AND match <> '{}'
            AND NOT (status = 'resolved' AND (
              json_extract(resolution, '$.kind') = 'withdrawn'
              OR (json_extract(resolution, '$.kind') = 'decided'
                  AND json_extract(resolution, '$.actionId') IS ${DONE_ACTION_ID})
            ))
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `;
        const breaker = breakers[0];
        // Every signal after the breaker that was not withdrawn was marked
        // Done, or it would be the breaker.
        const rows = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM signals
          WHERE kind = ${kind} AND match = ${stored} AND match <> '{}'
            AND ${breaker === undefined ? sql`1` : sql`(created_at, id) > (${breaker.created_at}, ${breaker.id})`}
            AND NOT (status = 'resolved' AND json_extract(resolution, '$.kind') = 'withdrawn')
        `;
        return rows[0]?.count ?? 0;
      }),

    /**
     * Returns every offer the core raised to suggest an Ignore Rule of
     * `kind`, open or resolved, with its id, its status and the rule it
     * offers. The core reads them so it never offers the same rule twice,
     * and a new rule resolves the open offer of the same rule. The query
     * reads the expression index `signals_ignore_rule_offer`.
     */
    listIgnoreRuleOffers: (
      kind: string,
    ): Effect.Effect<
      ReadonlyArray<{
        readonly id: string;
        readonly status: Signal["status"];
        readonly ignoreRule: NonNullable<Signal["ignoreRule"]>;
      }>,
      SqlError
    > =>
      Effect.map(
        sql<{
          readonly id: Uint8Array;
          readonly status: Signal["status"];
          readonly ignore_rule: string;
        }>`
          SELECT id, status, ignore_rule FROM signals
          WHERE ignore_rule IS NOT NULL AND json_extract(ignore_rule, '$.kind') = ${kind}
        `,
        (rows) =>
          rows.map((row) => ({
            id: uuidToString(row.id),
            status: row.status,
            ignoreRule: JSON.parse(row.ignore_rule) as NonNullable<Signal["ignoreRule"]>,
          })),
      ),

    /** Records that the signal `newId` replaced the resolved signal `oldId`. */
    recordReplacement: (oldId: string, newId: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        sql`UPDATE signals SET replaced_by = ${uuidFromString(newId)} WHERE id = ${uuidFromString(oldId)}`,
      ),

    /**
     * Checks whether a signal of `kind` was already written for the event
     * `eventId`, open or resolved. The step that raises a signal from an event
     * asks it, so a raise it runs a second time writes nothing.
     */
    hasSignalForEvent: (eventId: number, kind: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly found: number }>`
          SELECT 1 AS found FROM signal_events
          JOIN signals ON signals.id = signal_events.signal_id
          WHERE signal_events.event_id = ${eventId} AND signals.kind = ${kind}
          LIMIT 1
        `,
        (rows) => rows.length > 0,
      ),

    /**
     * Counts the signals of `kind` raised from the event `sinceEventId` or a
     * later one whose content was written from the event because the
     * plugin's `build` failed. It counts by event rather than by time because
     * raises are written in event order, and a signal and the notification
     * about its failed build are stamped a few milliseconds apart.
     */
    countBuildFailuresSince: (
      kind: string,
      sinceEventId: number,
    ): Effect.Effect<number, SqlError> =>
      Effect.map(
        sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM signals
          WHERE kind = ${kind} AND build_error IS NOT NULL
            AND json_extract(origin, '$.eventId') >= ${sinceEventId}
        `,
        (rows) => rows[0]?.count ?? 0,
      ),

    /**
     * Records a raise for the step after the commit. Writes nothing when the
     * event already has a raise of this kind, because the router may route
     * one event twice: a reroute after enrichment runs every rule again.
     */
    insertRaise: (raise: PendingRaise): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        INSERT OR IGNORE INTO signal_raises
          (event_id, kind, decision, connection_id, thread_ref)
        VALUES
          (${raise.eventId}, ${raise.kind}, ${raise.decision},
           ${uuidFromString(raise.connectionId)}, ${raise.threadRef})
      `),

    /** Returns every pending raise, oldest event first. */
    listPendingRaises: (): Effect.Effect<ReadonlyArray<PendingRaise>, SqlError> =>
      Effect.map(
        sql<PendingRaiseRow>`
          SELECT event_id, kind, decision, connection_id, thread_ref
          FROM signal_raises ORDER BY event_id, kind
        `,
        (rows) =>
          rows.map((row) => ({
            eventId: row.event_id,
            kind: row.kind,
            decision: row.decision,
            connectionId: uuidToString(row.connection_id),
            threadRef: row.thread_ref,
          })),
      ),

    /**
     * Deletes one pending raise, once its signal is written or it is skipped.
     * Returns false when the raise was already gone, because an end on its
     * thread dropped it, or another pass handled it.
     */
    deleteRaise: (eventId: number, kind: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly event_id: number }>`
          DELETE FROM signal_raises WHERE event_id = ${eventId} AND kind = ${kind}
          RETURNING event_id
        `,
        (rows) => rows.length > 0,
      ),

    /**
     * Deletes the pending raises of `kind` on one thread of a Connection
     * whose event came before `beforeEventId`. An event that ends the kind's
     * signals on the thread calls it, so a raise the step has not written
     * yet does not bring back a question that was already answered.
     */
    deleteRaisesOnThreadBefore: (
      connectionId: string,
      threadRef: string,
      kind: string,
      beforeEventId: number,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        DELETE FROM signal_raises
        WHERE connection_id = ${uuidFromString(connectionId)} AND thread_ref = ${threadRef}
          AND kind = ${kind} AND event_id < ${beforeEventId}
      `),

    /**
     * Records that the event `eventId` ended `kind` on one thread of a
     * Connection. Keeps the latest such event when one is already recorded,
     * because an older event routed again may record an older end.
     */
    recordThreadEnd: (
      connectionId: string,
      threadRef: string,
      kind: string,
      eventId: number,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        INSERT INTO signal_thread_ends (connection_id, thread_ref, kind, event_id)
        VALUES (${uuidFromString(connectionId)}, ${threadRef}, ${kind}, ${eventId})
        ON CONFLICT (connection_id, thread_ref, kind)
        DO UPDATE SET event_id = MAX(event_id, excluded.event_id)
      `),

    /**
     * Checks whether an event later than `eventId` ended `kind` on one thread
     * of a Connection. A raise from `eventId` would then ask a question that
     * was already answered.
     */
    hasThreadEndAfter: (
      connectionId: string,
      threadRef: string,
      kind: string,
      eventId: number,
    ): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly found: number }>`
          SELECT 1 AS found FROM signal_thread_ends
          WHERE connection_id = ${uuidFromString(connectionId)} AND thread_ref = ${threadRef}
            AND kind = ${kind} AND event_id > ${eventId}
        `,
        (rows) => rows.length > 0,
      ),
  };
});

/** Everything the signal service reads and writes. */
export const signalRepository = make;
