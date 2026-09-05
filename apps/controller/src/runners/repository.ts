/**
 * Runner rows. Nothing here decides policy - who may write, what a change
 * means, what gets logged - it only reads and writes.
 *
 * One walk answers a listing: a keyset over the name plus the id, which
 * `runners_name` serves. The two filters narrow that walk; neither is indexed,
 * because a fleet is a few dozen machines and an index on either would serve a
 * scan that reads them all anyway.
 *
 * The reported columns hold JSON, decoded on its way in by whatever writes it
 * and read back here as the shape that writer produced, the way a task's labels
 * are. Nothing queries inside them, so they are documents rather than columns.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type {
  Runner,
  RunnerDetail,
  RunnerFacts,
  RunnerState,
  RunnerWatermark,
  SortDirection,
} from "@hydra/contract";
import {
  decodeCursor,
  encodeCursor,
  keysetOver,
  mintUuid,
  pageOf,
  uuidFromString,
  uuidToString,
  type CursorError,
  type CursorScope,
  type Page,
} from "../db";

/** What a fleet listing asks for. */
export interface RunnerPageRequest {
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly direction: SortDirection;
  readonly state: RunnerState | undefined;
  readonly label: string | undefined;
}

/** Everything a new runner row holds. The rest is what the runner reports. */
export interface NewRunner {
  readonly name: string;
  readonly state: RunnerState;
  readonly labels: ReadonlyArray<string>;
  readonly maxConcurrentSessions: number;
  /** Only the hash of the runner's durable credential is ever stored. */
  readonly credentialHash: string;
  readonly at: string;
}

/** The columns an edit may set. An absent one is left as it was. */
export interface RunnerEdit {
  readonly name?: string;
  readonly labels?: ReadonlyArray<string>;
  readonly maxConcurrentSessions?: number;
}

interface RunnerRow {
  readonly id: Uint8Array;
  readonly name: string;
  readonly state: RunnerState;
  readonly labels: string;
  readonly max_concurrent_sessions: number;
  readonly binary_version: string | null;
  readonly protocol_version: number | null;
  readonly negotiated_capabilities: string | null;
  readonly facts: string | null;
  readonly watermark: string | null;
  readonly last_seen_at: string | null;
}

const COLUMNS =
  "id, name, state, labels, max_concurrent_sessions, binary_version, protocol_version, " +
  "negotiated_capabilities, facts, watermark, last_seen_at";

const scopeOf = (direction: SortDirection): CursorScope => ({
  op: "runner.query",
  field: "name",
  direction,
});

/** One JSON column, or null where the runner has not reported it yet. */
const parsed = <A>(column: string | null): A | null =>
  column === null ? null : (JSON.parse(column) as A);

const toRunner = (row: RunnerRow): Runner => ({
  id: uuidToString(row.id),
  name: row.name,
  state: row.state,
  version: row.binary_version,
  labels: JSON.parse(row.labels) as ReadonlyArray<string>,
  facts: parsed<RunnerFacts>(row.facts),
  watermark: parsed<RunnerWatermark>(row.watermark),
  maxConcurrentSessions: row.max_concurrent_sessions,
  lastSeenAt: row.last_seen_at,
});

const toDetail = (row: RunnerRow): RunnerDetail => ({
  ...toRunner(row),
  negotiatedCapabilities: parsed<ReadonlyArray<string>>(row.negotiated_capabilities),
  protocolVersion: row.protocol_version,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /** The runner with that id, in full. */
    read: (id: string): Effect.Effect<Option.Option<RunnerDetail>, SqlError> =>
      Effect.map(
        sql<RunnerRow>`SELECT ${sql.literal(COLUMNS)} FROM runners
                       WHERE id = ${uuidFromString(id)}`,
        (rows) => Option.fromNullishOr(rows[0]).pipe(Option.map(toDetail)),
      ),

    /** Every name the fleet holds, so a joining machine can be given a free one. */
    names: (): Effect.Effect<ReadonlySet<string>, SqlError> =>
      Effect.map(
        sql<{ readonly name: string }>`SELECT name FROM runners`,
        (rows) => new Set(rows.map((row) => row.name)),
      ),

    /** Enlists a runner. Everything it reports about itself arrives later. */
    insert: (runner: NewRunner): Effect.Effect<RunnerDetail, SqlError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        yield* sql`
          INSERT INTO runners
            (id, name, state, labels, max_concurrent_sessions, credential_hash,
             created_at, updated_at)
          VALUES
            (${id}, ${runner.name}, ${runner.state}, ${JSON.stringify(runner.labels)},
             ${runner.maxConcurrentSessions}, ${runner.credentialHash},
             ${runner.at}, ${runner.at})
        `;
        return {
          id: uuidToString(id),
          name: runner.name,
          state: runner.state,
          version: null,
          labels: runner.labels,
          facts: null,
          watermark: null,
          maxConcurrentSessions: runner.maxConcurrentSessions,
          lastSeenAt: null,
          negotiatedCapabilities: null,
          protocolVersion: null,
        };
      }),

    /** Applies an edit. Only the columns the edit names are written. */
    update: (id: string, edit: RunnerEdit, at: string): Effect.Effect<void, SqlError> => {
      const sets = [sql`updated_at = ${at}`];
      if (edit.name !== undefined) sets.push(sql`name = ${edit.name}`);
      if (edit.labels !== undefined) sets.push(sql`labels = ${JSON.stringify(edit.labels)}`);
      if (edit.maxConcurrentSessions !== undefined) {
        sets.push(sql`max_concurrent_sessions = ${edit.maxConcurrentSessions}`);
      }
      return Effect.asVoid(
        sql`UPDATE runners SET ${sql.csv(sets)} WHERE id = ${uuidFromString(id)}`,
      );
    },

    /** One page of the fleet, by name. */
    list: (request: RunnerPageRequest): Effect.Effect<Page<Runner>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope = scopeOf(request.direction);
        // The one sortable column of a runner holds text.
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeCursor(request.cursor, scope, "string");
        const { keyset, order } = keysetOver(
          sql,
          ["name", "id"],
          after === undefined ? undefined : [after[0], uuidFromString(after[1])],
          request.direction,
        );
        const clauses = [keyset];
        if (request.state !== undefined) clauses.push(sql`state = ${request.state}`);
        if (request.label !== undefined) {
          clauses.push(
            sql`EXISTS (SELECT 1 FROM json_each(runners.labels) WHERE value = ${request.label})`,
          );
        }
        const rows = yield* sql<RunnerRow>`
          SELECT ${sql.literal(COLUMNS)} FROM runners
          WHERE ${sql.and(clauses)} ${order} LIMIT ${request.limit + 1}
        `;
        return yield* pageOf(
          rows,
          request.limit,
          (page) => Effect.succeed(page.map(toRunner)),
          (last) => encodeCursor(scope, last.name, last.id),
        );
      }),
  };
});

/** Everything the runner service reads and writes. */
export const runnerRepository = make;
