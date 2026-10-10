/**
 * Signal rows.
 *
 * This module reads and writes the contract's `Signal`. The origin, the
 * blocks, the actions, the match values, the task, the Ignore Rule and the
 * resolution are stored as JSON, because a signal is read and written whole.
 * The events a signal is about are also kept in `signal_events`, so a prune
 * of the event log can find them by index. Nothing here decides policy; it
 * only reads and writes.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type {
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
import { uuidFromString, uuidToString } from "../db";

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
}

const COLUMNS =
  "id, kind, origin, title, asker, place, priority, blocks, actions, match, build_error, task, ignore_rule, status, resolution, replaced_by, created_at";

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
});

/** Converts an optional value into a JSON column's value, or `null` when it is absent. */
const encodeOptionalJson = (value: unknown): string | null =>
  value === undefined ? null : JSON.stringify(value);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /**
     * Writes a new signal, and one `signal_events` row for each event its
     * origin names.
     */
    insert: (signal: NewSignal, eventIds: ReadonlyArray<number>): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const id = uuidFromString(signal.id);
        yield* sql`
          INSERT INTO signals
            (id, kind, origin, title, asker, place, priority, blocks, actions, match, build_error,
             task, ignore_rule, status, resolution, replaced_by, created_at)
          VALUES
            (${id}, ${signal.kind}, ${JSON.stringify(signal.origin)}, ${signal.title},
             ${signal.asker ?? null}, ${signal.place ?? null}, ${signal.priority},
             ${JSON.stringify(signal.blocks)}, ${JSON.stringify(signal.actions)},
             ${JSON.stringify(signal.match)}, ${encodeOptionalJson(signal.buildError)},
             ${encodeOptionalJson(signal.task)}, ${encodeOptionalJson(signal.ignoreRule)},
             ${signal.status}, ${encodeOptionalJson(signal.resolution)},
             ${signal.replacedBy === undefined ? null : uuidFromString(signal.replacedBy)},
             ${signal.createdAt})
        `;
        // A raiser may name one event twice; the table keeps each pair once.
        for (const eventId of new Set(eventIds)) {
          yield* sql`INSERT INTO signal_events (signal_id, event_id) VALUES (${id}, ${eventId})`;
        }
      }),

    /** Returns the signal with that id, or none if it does not exist. */
    read: (id: string): Effect.Effect<Option.Option<Signal>, SqlError> =>
      Effect.map(
        sql<SignalRow>`SELECT ${sql.literal(COLUMNS)} FROM signals WHERE id = ${uuidFromString(id)}`,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), parseRow),
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
     * Returns every open signal, oldest first. `kind` keeps the signals of
     * one kind, and `source` the signals of one plugin's kinds, whose kind
     * starts with `<source>/`. The open signals are few, so the list is not
     * paged.
     */
    listOpen: (filter: {
      readonly kind?: string;
      readonly source?: string;
    }): Effect.Effect<ReadonlyArray<Signal>, SqlError> => {
      const clauses = [sql`status = 'open'`];
      if (filter.kind !== undefined) clauses.push(sql`kind = ${filter.kind}`);
      // A plugin id holds no `%` or `_`, so the pattern matches only the prefix.
      if (filter.source !== undefined) clauses.push(sql`kind LIKE ${`${filter.source}/%`}`);
      return Effect.map(
        sql<SignalRow>`
          SELECT ${sql.literal(COLUMNS)} FROM signals
          WHERE ${sql.and(clauses)}
          ORDER BY created_at, id
        `,
        (rows) => rows.map(parseRow),
      );
    },

    /**
     * Resolves an open signal. Returns false, and writes nothing, when the
     * signal is not open, so two resolutions racing each other cannot both
     * win.
     */
    resolve: (id: string, resolution: SignalResolution): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          UPDATE signals SET status = 'resolved', resolution = ${JSON.stringify(resolution)}
          WHERE id = ${uuidFromString(id)} AND status = 'open'
          RETURNING id
        `,
        (rows) => rows.length === 1,
      ),
  };
});

/** Everything the signal service reads and writes. */
export const signalRepository = make;
