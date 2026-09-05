/**
 * Runner rows; nothing here decides policy. A listing is one keyset walk over
 * `runners_name`, and neither filter is indexed because a fleet is a few dozen
 * machines. The reported columns hold JSON, since nothing queries inside them.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { RunnerCapabilities, RunnerFacts, RunnerWatermark } from "@hydra/contract";
import type { Runner, RunnerDetail, RunnerState, SortDirection } from "@hydra/contract";
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

export interface RunnerPageRequest {
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly direction: SortDirection;
  readonly state: RunnerState | undefined;
  readonly label: string | undefined;
}

export interface NewRunner {
  readonly name: string;
  readonly state: RunnerState;
  readonly labels: ReadonlyArray<string>;
  readonly maxConcurrentSessions: number;
  /** Only the hash of the runner's durable credential is ever stored. */
  readonly credentialHash: string;
  readonly at: string;
}

export interface RunnerHelloRecord {
  readonly binaryVersion: string;
  readonly protocolVersion: number;
  readonly negotiatedCapabilities: ReadonlyArray<string>;
  readonly facts: RunnerFacts;
}

/** An absent column is left as it was. */
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

/**
 * A document this build cannot read comes back as absent rather than failing the
 * page it is on: one row written by another version must not take a whole fleet
 * listing with it.
 */
const documentIn = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, what: string) => {
  const decode = Schema.decodeUnknownExit(Schema.fromJsonString(schema));
  return (id: string, column: string | null): Effect.Effect<S["Type"] | null> => {
    if (column === null) return Effect.succeed(null);
    const decoded = decode(column);
    if (decoded._tag === "Success") return Effect.succeed(decoded.value);
    return Effect.as(
      Effect.logWarning(
        `Runner ${id}: its ${what} were written by a build this one cannot read, ` +
          `and are answered as though the runner had never reported them.`,
      ),
      null,
    );
  };
};

const factsIn = documentIn(RunnerFacts, "facts");
const watermarkIn = documentIn(RunnerWatermark, "watermark");
const capabilitiesIn = documentIn(RunnerCapabilities, "negotiated capabilities");

const toRunner = (row: RunnerRow): Effect.Effect<Runner> =>
  Effect.gen(function* () {
    const id = uuidToString(row.id);
    return {
      id,
      name: row.name,
      state: row.state,
      version: row.binary_version,
      labels: JSON.parse(row.labels) as ReadonlyArray<string>,
      facts: yield* factsIn(id, row.facts),
      watermark: yield* watermarkIn(id, row.watermark),
      maxConcurrentSessions: row.max_concurrent_sessions,
      lastSeenAt: row.last_seen_at,
    };
  });

const toDetail = (row: RunnerRow): Effect.Effect<RunnerDetail> =>
  Effect.gen(function* () {
    return {
      ...(yield* toRunner(row)),
      negotiatedCapabilities: yield* capabilitiesIn(
        uuidToString(row.id),
        row.negotiated_capabilities,
      ),
      protocolVersion: row.protocol_version,
    };
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    read: (id: string): Effect.Effect<Option.Option<RunnerDetail>, SqlError> =>
      Effect.flatMap(
        sql<RunnerRow>`SELECT ${sql.literal(COLUMNS)} FROM runners
                       WHERE id = ${uuidFromString(id)}`,
        (rows) =>
          rows[0] === undefined
            ? Effect.succeed(Option.none())
            : Effect.map(toDetail(rows[0]), Option.some),
      ),

    /** A `retired` runner's credential is revoked, so it resolves to nothing. */
    byCredential: (credentialHash: string): Effect.Effect<Option.Option<string>, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          SELECT id FROM runners
          WHERE credential_hash = ${credentialHash} AND state <> 'retired'
        `,
        (rows) => Option.fromNullishOr(rows[0]).pipe(Option.map((row) => uuidToString(row.id))),
      ),

    connected: (): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`SELECT id FROM runners WHERE state = 'online'`,
        (rows) => rows.map((row) => uuidToString(row.id)),
      ),

    /** So a joining machine can be given a free one. */
    names: (): Effect.Effect<ReadonlySet<string>, SqlError> =>
      Effect.map(
        sql<{ readonly name: string }>`SELECT name FROM runners`,
        (rows) => new Set(rows.map((row) => row.name)),
      ),

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

    /** The state is `setState`'s, so one statement decides whether the row moved. */
    recordHello: (
      id: string,
      hello: RunnerHelloRecord,
      at: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        UPDATE runners SET
          binary_version = ${hello.binaryVersion},
          protocol_version = ${hello.protocolVersion},
          negotiated_capabilities = ${JSON.stringify(hello.negotiatedCapabilities)},
          facts = ${JSON.stringify(hello.facts)},
          last_seen_at = ${at},
          updated_at = ${at}
        WHERE id = ${uuidFromString(id)}
      `),

    /** The report is the whole of it: only the latest reading is worth anything. */
    recordFacts: (id: string, facts: RunnerFacts, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        sql`UPDATE runners SET facts = ${JSON.stringify(facts)}, updated_at = ${at}
            WHERE id = ${uuidFromString(id)}`,
      ),

    /**
     * The reading is refreshed every time, but only the crossing is acted on.
     * The old one goes through the same tolerant decode the API answers with, so
     * an unreadable column does not take the connection down. A machine that has
     * said nothing is taken to be accepting work.
     */
    recordWatermark: (
      id: string,
      watermark: RunnerWatermark,
      at: string,
    ): Effect.Effect<boolean, SqlError> =>
      Effect.gen(function* () {
        const key = uuidFromString(id);
        const rows = yield* sql<{
          readonly watermark: string | null;
        }>`SELECT watermark FROM runners WHERE id = ${key}`;
        const was = yield* watermarkIn(id, rows[0]?.watermark ?? null);
        yield* sql`UPDATE runners
                   SET watermark = ${JSON.stringify(watermark)}, updated_at = ${at}
                   WHERE id = ${key}`;
        return (was?.acceptingPlacements ?? true) !== watermark.acceptingPlacements;
      }),

    touch: (id: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        sql`UPDATE runners SET last_seen_at = ${at}, updated_at = ${at}
            WHERE id = ${uuidFromString(id)}`,
      ),

    /** Answers whether it moved, so nothing records a change that did not happen. */
    setState: (id: string, state: RunnerState, at: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          UPDATE runners SET state = ${state}, updated_at = ${at}
          WHERE id = ${uuidFromString(id)} AND state <> ${state}
          RETURNING id
        `,
        (rows) => rows.length > 0,
      ),

    list: (request: RunnerPageRequest): Effect.Effect<Page<Runner>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope = scopeOf(request.direction);
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
          (page) => Effect.forEach(page, toRunner),
          (last) => encodeCursor(scope, last.name, last.id),
        );
      }),
  };
});

export const runnerRepository = make;
