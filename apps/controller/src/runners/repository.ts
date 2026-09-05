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

/** What a runner said about itself when it opened its connection. */
export interface RunnerHelloRecord {
  readonly binaryVersion: string;
  readonly protocolVersion: number;
  readonly negotiatedCapabilities: ReadonlyArray<string>;
  readonly facts: RunnerFacts;
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

/**
 * Reads one JSON column as the shape the public API answers with.
 *
 * A document this build cannot read comes back as absent rather than failing
 * the page it is on. These columns hold what a runner reported, so one row
 * written by a version that says something else must not take a whole fleet
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
    /** The runner with that id, in full. */
    read: (id: string): Effect.Effect<Option.Option<RunnerDetail>, SqlError> =>
      Effect.flatMap(
        sql<RunnerRow>`SELECT ${sql.literal(COLUMNS)} FROM runners
                       WHERE id = ${uuidFromString(id)}`,
        (rows) =>
          rows[0] === undefined
            ? Effect.succeed(Option.none())
            : Effect.map(toDetail(rows[0]), Option.some),
      ),

    /**
     * The runner this credential belongs to, if it is one a machine may still
     * connect with. A `retired` runner's credential is revoked, so it resolves
     * to nothing rather than to a row nobody may use.
     */
    byCredential: (credentialHash: string): Effect.Effect<Option.Option<string>, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          SELECT id FROM runners
          WHERE credential_hash = ${credentialHash} AND state <> 'retired'
        `,
        (rows) => Option.fromNullishOr(rows[0]).pipe(Option.map((row) => uuidToString(row.id))),
      ),

    /** Every runner a connection is supposed to be open to. */
    connected: (): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`SELECT id FROM runners WHERE state = 'online'`,
        (rows) => rows.map((row) => uuidToString(row.id)),
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

    /**
     * Stores everything a runner's hello said about itself. The state is not
     * here: moving a runner is `setState`, so that one statement decides both
     * whether the row changed and whether that change is worth recording.
     */
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

    /**
     * Stores what a runner reported about its machine. The report is the whole
     * of it: only the latest reading is worth anything, and a runner sends one
     * only when something changed.
     */
    recordFacts: (id: string, facts: RunnerFacts, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        sql`UPDATE runners SET facts = ${JSON.stringify(facts)}, updated_at = ${at}
            WHERE id = ${uuidFromString(id)}`,
      ),

    /**
     * Stores the headroom a runner reported, and answers whether that changed
     * what the fleet may do with the machine. The reading itself is refreshed
     * every time - it is what the row is for - but only the crossing of the
     * watermark is a change anything else acts on.
     *
     * The old reading is read through the same tolerant decode the API answers
     * with, so a column this build cannot make sense of does not become a
     * statement that fails and takes the runner's connection with it.
     *
     * A machine that has said nothing yet is taken to be accepting work, so the
     * first reading of a healthy disk is not news. A first reading that says
     * the machine has no room left is.
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

    /** Records that the runner answered, without changing what it is. */
    touch: (id: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        sql`UPDATE runners SET last_seen_at = ${at}, updated_at = ${at}
            WHERE id = ${uuidFromString(id)}`,
      ),

    /**
     * Moves a runner to a state and answers whether it moved. A runner already
     * in that state is left alone, so nothing records a change that did not
     * happen.
     */
    setState: (id: string, state: RunnerState, at: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          UPDATE runners SET state = ${state}, updated_at = ${at}
          WHERE id = ${uuidFromString(id)} AND state <> ${state}
          RETURNING id
        `,
        (rows) => rows.length > 0,
      ),

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
          (page) => Effect.forEach(page, toRunner),
          (last) => encodeCursor(scope, last.name, last.id),
        );
      }),
  };
});

/** Everything the runner service reads and writes. */
export const runnerRepository = make;
