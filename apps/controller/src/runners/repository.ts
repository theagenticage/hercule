/**
 * The repository for runner rows; nothing here decides policy. A list is one
 * keyset query over the `runners_name` index. The filters are not indexed,
 * because a fleet has at most a few dozen runners. The columns a runner reports
 * hold JSON, because nothing queries inside them.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { RunnerCapabilities, RunnerFacts, RunnerWatermark } from "@hercule/contract";
import type {
  Runner,
  RunnerConnectivity,
  RunnerDetail,
  RunnerLifecycle,
  SortDirection,
} from "@hercule/contract";
import {
  decodeCursor,
  encodeCursor,
  buildKeyset,
  mintUuid,
  buildPage,
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
  readonly connectivity: RunnerConnectivity | undefined;
  readonly lifecycle: RunnerLifecycle | undefined;
  readonly label: string | undefined;
}

export interface NewRunner {
  readonly name: string;
  readonly connectivity: RunnerConnectivity;
  readonly lifecycle: RunnerLifecycle;
  readonly reserved: boolean;
  readonly labels: ReadonlyArray<string>;
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

/**
 * A runner that is not retired, as run pinning sees it: whether a placement
 * that names no runner may choose it now, and the capabilities it negotiated
 * at its last hello. A runner that has never said hello has none.
 */
export interface PlacementCandidate {
  readonly id: string;
  readonly placeable: boolean;
  readonly capabilities: ReadonlyArray<string>;
}

/** The runner fields to change. A field that is `undefined` is left as it was. */
export interface RunnerEdit {
  readonly name?: string;
  readonly labels?: ReadonlyArray<string>;
  readonly maxConcurrentSessions?: number;
  readonly diskWatermarkBytes?: number;
  readonly reserved?: boolean;
}

interface RunnerRow {
  readonly id: Uint8Array;
  readonly name: string;
  readonly connectivity: RunnerConnectivity;
  readonly lifecycle: RunnerLifecycle;
  readonly reserved: number;
  readonly labels: string;
  readonly max_concurrent_sessions: number | null;
  readonly disk_watermark_bytes: number | null;
  readonly binary_version: string | null;
  readonly protocol_version: number | null;
  readonly negotiated_capabilities: string | null;
  readonly facts: string | null;
  readonly watermark: string | null;
  readonly last_seen_at: string | null;
}

const COLUMNS =
  "id, name, connectivity, lifecycle, reserved, labels, max_concurrent_sessions, " +
  "disk_watermark_bytes, binary_version, protocol_version, negotiated_capabilities, " +
  "facts, watermark, last_seen_at";

/**
 * The memory one session is assumed to need. A runner's default session cap
 * is its memory divided by this, and never less than one. Spec 03 §5.3 owns
 * the rule.
 */
const BYTES_PER_SESSION = 2 * 1024 ** 3;

/**
 * The free disk space below which a runner takes no new placements, unless
 * the owner sets another value for that runner. Spec 03 §6.2 owns the default.
 */
const DEFAULT_DISK_WATERMARK_BYTES = 10 * 1024 ** 3;

/**
 * Returns the session cap the API reports: the owner's override, or one
 * session per 2 GiB of memory. A runner that has not reported its facts yet
 * gets a cap of one, rather than no capacity at all.
 */
const computeEffectiveCap = (override: number | null, facts: RunnerFacts | null): number =>
  override ??
  (facts === null ? 1 : Math.max(1, Math.floor(facts.totalMemoryBytes / BYTES_PER_SESSION)));

/** Returns the disk watermark dispatch checks placements against: the owner's override, or the default. */
const computeEffectiveWatermark = (override: number | null): number =>
  override ?? DEFAULT_DISK_WATERMARK_BYTES;

const buildCursorScope = (direction: SortDirection): CursorScope => ({
  op: "runner.query",
  field: "name",
  direction,
});

/**
 * Builds a decoder for one JSON column. A value this build cannot decode is
 * returned as `null`, with a warning in the log, rather than failing the whole
 * page: one row written by another version must not break the fleet list.
 */
const buildDocumentDecoder = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  what: string,
) => {
  const decode = Schema.decodeUnknownExit(Schema.fromJsonString(schema));
  return (id: string, column: string | null): Effect.Effect<S["Type"] | null> => {
    if (column === null) return Effect.succeed(null);
    const decoded = decode(column);
    if (decoded._tag === "Success") return Effect.succeed(decoded.value);
    return Effect.as(
      Effect.logWarning(
        `Runner ${id}: its ${what} were written by a build this one cannot read, ` +
          `so they are returned as though the runner had never reported them.`,
      ),
      null,
    );
  };
};

const factsIn = buildDocumentDecoder(RunnerFacts, "facts");
const watermarkIn = buildDocumentDecoder(RunnerWatermark, "watermark");
const capabilitiesIn = buildDocumentDecoder(RunnerCapabilities, "negotiated capabilities");

const toRunner = (row: RunnerRow): Effect.Effect<Runner> =>
  Effect.gen(function* () {
    const id = uuidToString(row.id);
    const facts = yield* factsIn(id, row.facts);
    return {
      id,
      name: row.name,
      connectivity: row.connectivity,
      lifecycle: row.lifecycle,
      reserved: row.reserved === 1,
      version: row.binary_version,
      labels: JSON.parse(row.labels) as ReadonlyArray<string>,
      facts,
      watermark: yield* watermarkIn(id, row.watermark),
      maxConcurrentSessions: computeEffectiveCap(row.max_concurrent_sessions, facts),
      diskWatermarkBytes: computeEffectiveWatermark(row.disk_watermark_bytes),
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

/**
 * Builds the SQL condition for a runner that can receive frames now: connected,
 * and not retired or draining. It is exported as a fragment because the
 * workspace sweep checks the same thing for a workspace's runner (a workspace
 * is never disposed of behind its runner's back), and two definitions of
 * "online" could disagree.
 */
export const buildOnlineClause = (alias: string): string =>
  `${alias}.connectivity = 'online' AND ${alias}.lifecycle = 'active'`;

/**
 * The SQL condition for a runner a placement that names no runner may choose:
 * online, active, and not reserved. `placeable` and `listPlacementCandidates`
 * share it, so the two cannot disagree.
 */
const PLACEABLE = `${buildOnlineClause("runners")} AND runners.reserved = 0`;

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

    /** Returns the id of the runner with this credential hash. A `retired` runner's credential is revoked, so it returns `none`. */
    byCredential: (credentialHash: string): Effect.Effect<Option.Option<string>, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          SELECT id FROM runners
          WHERE credential_hash = ${credentialHash} AND lifecycle <> 'retired'
        `,
        (rows) => Option.fromNullishOr(rows[0]).pipe(Option.map((row) => uuidToString(row.id))),
      ),

    /**
     * Checks whether this credential belonged to a retired runner. It is called
     * only after a credential was rejected, so the runner can be told it was
     * retired rather than that it is unknown.
     */
    wasRetired: (credentialHash: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          SELECT id FROM runners
          WHERE credential_hash = ${credentialHash} AND lifecycle = 'retired'
        `,
        (rows) => rows.length > 0,
      ),

    /**
     * Returns the runners that are unreachable and were last seen at or before
     * `cutoff`, with their names and when they were last seen. A retired
     * runner is left out: nobody waits for it to come back.
     */
    listUnreachableSeenBefore: (
      cutoff: string,
    ): Effect.Effect<
      ReadonlyArray<{ readonly id: string; readonly name: string; readonly lastSeenAt: string }>,
      SqlError
    > =>
      Effect.map(
        sql<{ readonly id: Uint8Array; readonly name: string; readonly last_seen_at: string }>`
          SELECT id, name, last_seen_at FROM runners
          WHERE connectivity = 'unreachable' AND lifecycle <> 'retired'
            AND last_seen_at <= ${cutoff}
          ORDER BY last_seen_at, id
        `,
        (rows) =>
          rows.map((row) => ({
            id: uuidToString(row.id),
            name: row.name,
            lastSeenAt: row.last_seen_at,
          })),
      ),

    connected: (): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`SELECT id FROM runners WHERE connectivity = 'online'`,
        (rows) => rows.map((row) => uuidToString(row.id)),
      ),

    /**
     * Returns the runners a placement that names no runner may choose: online,
     * active, and not reserved.
     *
     * Leaving out reserved runners is what makes this the fallback list rather
     * than a plain list (see Reserved in CONTEXT.md: the placement fallback
     * never chooses a reserved runner). The disk watermark is not checked
     * here: placement picks the runner, and dispatch decides when a session
     * placed on it actually starts.
     */
    placeable: (): Effect.Effect<ReadonlySet<string>, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          SELECT id FROM runners WHERE ${sql.literal(PLACEABLE)}
        `,
        (rows) => new Set(rows.map((row) => uuidToString(row.id))),
      ),

    /**
     * Returns every runner that is neither retired nor reserved, with whether
     * it is placeable (see `placeable`) and its negotiated capabilities. A
     * retired runner is left out because it never connects again, and a
     * reserved one because work that names no runner never goes to it. A
     * draining or offline runner is kept: it may take work again later.
     */
    listPlacementCandidates: (): Effect.Effect<ReadonlyArray<PlacementCandidate>, SqlError> =>
      Effect.flatMap(
        sql<{
          readonly id: Uint8Array;
          readonly placeable: number;
          readonly negotiated_capabilities: string | null;
        }>`
          SELECT id, (${sql.literal(PLACEABLE)}) AS placeable, negotiated_capabilities
          FROM runners WHERE lifecycle <> 'retired' AND reserved = 0
        `,
        (rows) =>
          Effect.forEach(rows, (row) => {
            const id = uuidToString(row.id);
            return Effect.map(capabilitiesIn(id, row.negotiated_capabilities), (capabilities) => ({
              id,
              placeable: row.placeable === 1,
              capabilities: capabilities ?? [],
            }));
          }),
      ),

    /** Returns every runner name, so a joining runner can get a free one. */
    names: (): Effect.Effect<ReadonlySet<string>, SqlError> =>
      Effect.map(
        sql<{ readonly name: string }>`SELECT name FROM runners`,
        (rows) => new Set(rows.map((row) => row.name)),
      ),

    /**
     * Stores a new runner and returns it, built from the row the insert
     * returned, so there is one way to read a runner and not two. The session
     * cap is not written: facts first arrive with the hello, so a new row has
     * nothing to compute a cap from, and the cap is computed on read.
     */
    insert: (runner: NewRunner): Effect.Effect<RunnerDetail, SqlError> =>
      Effect.flatMap(
        sql<RunnerRow>`
          INSERT INTO runners
            (id, name, connectivity, lifecycle, reserved, labels,
             credential_hash, created_at, updated_at)
          VALUES
            (${mintUuid()}, ${runner.name}, ${runner.connectivity}, ${runner.lifecycle},
             ${runner.reserved ? 1 : 0}, ${JSON.stringify(runner.labels)},
             ${runner.credentialHash}, ${runner.at}, ${runner.at})
          RETURNING ${sql.literal(COLUMNS)}
        `,
        (rows) => toDetail(rows[0]!),
      ),

    update: (id: string, edit: RunnerEdit, at: string): Effect.Effect<void, SqlError> => {
      const sets = [sql`updated_at = ${at}`];
      if (edit.name !== undefined) sets.push(sql`name = ${edit.name}`);
      if (edit.labels !== undefined) sets.push(sql`labels = ${JSON.stringify(edit.labels)}`);
      if (edit.maxConcurrentSessions !== undefined) {
        sets.push(sql`max_concurrent_sessions = ${edit.maxConcurrentSessions}`);
      }
      if (edit.diskWatermarkBytes !== undefined) {
        sets.push(sql`disk_watermark_bytes = ${edit.diskWatermarkBytes}`);
      }
      if (edit.reserved !== undefined) sets.push(sql`reserved = ${edit.reserved ? 1 : 0}`);
      return Effect.asVoid(
        sql`UPDATE runners SET ${sql.csv(sets)} WHERE id = ${uuidFromString(id)}`,
      );
    },

    /**
     * Stores what a runner's hello reported. Connectivity is left to
     * `setConnectivity`, so one statement decides whether it changed.
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

    /** Replaces the runner's facts with the latest report; older reports are not kept. */
    recordFacts: (id: string, facts: RunnerFacts, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        sql`UPDATE runners SET facts = ${JSON.stringify(facts)}, updated_at = ${at}
            WHERE id = ${uuidFromString(id)}`,
      ),

    /**
     * Stores the runner's latest watermark report. Returns whether the runner
     * now accepts work (enough free disk for the effective watermark), and
     * whether that changed since the last report; only a change is acted on.
     * The old report is decoded the same tolerant way as for the API, so an
     * unreadable column does not break the connection. A runner with no
     * earlier report counts as accepting work.
     */
    recordWatermark: (
      id: string,
      watermark: RunnerWatermark,
      at: string,
    ): Effect.Effect<{ readonly crossed: boolean; readonly accepting: boolean }, SqlError> =>
      Effect.gen(function* () {
        const key = uuidFromString(id);
        const rows = yield* sql<{
          readonly watermark: string | null;
          readonly disk_watermark_bytes: number | null;
        }>`SELECT watermark, disk_watermark_bytes FROM runners WHERE id = ${key}`;
        const was = yield* watermarkIn(id, rows[0]?.watermark ?? null);
        const effective = computeEffectiveWatermark(rows[0]?.disk_watermark_bytes ?? null);
        yield* sql`UPDATE runners
                   SET watermark = ${JSON.stringify(watermark)}, updated_at = ${at}
                   WHERE id = ${key}`;
        const wasAccepting = was === null ? true : was.diskFreeBytes >= effective;
        const accepting = watermark.diskFreeBytes >= effective;
        return { crossed: wasAccepting !== accepting, accepting };
      }),

    touch: (id: string, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        sql`UPDATE runners SET last_seen_at = ${at}, updated_at = ${at}
            WHERE id = ${uuidFromString(id)}`,
      ),

    /** Sets the runner's connectivity. Returns whether it changed, so nothing records a change that did not happen. */
    setConnectivity: (
      id: string,
      connectivity: RunnerConnectivity,
      at: string,
    ): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly id: Uint8Array }>`
          UPDATE runners SET connectivity = ${connectivity}, updated_at = ${at}
          WHERE id = ${uuidFromString(id)} AND connectivity <> ${connectivity}
          RETURNING id
        `,
        (rows) => rows.length > 0,
      ),

    /** Sets the runner's lifecycle (active, draining, retired). Only the owner changes it; the socket never does. */
    setLifecycle: (
      id: string,
      lifecycle: RunnerLifecycle,
      at: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        sql`UPDATE runners SET lifecycle = ${lifecycle}, updated_at = ${at}
            WHERE id = ${uuidFromString(id)}`,
      ),

    /** Counts the runner's sessions that are `starting`, `idle` or `busy`: the ones it is running now. */
    runningSessions: (id: string): Effect.Effect<number, SqlError> =>
      Effect.map(
        sql<{ readonly n: number }>`
          SELECT COUNT(*) AS n FROM sessions
          WHERE runner_id = ${uuidFromString(id)} AND status IN ('starting', 'idle', 'busy')
        `,
        (rows) => rows[0]?.n ?? 0,
      ),

    list: (request: RunnerPageRequest): Effect.Effect<Page<Runner>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope = buildCursorScope(request.direction);
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeCursor(request.cursor, scope, "string");
        const { keyset, order } = buildKeyset(
          sql,
          ["name", "id"],
          after === undefined ? undefined : [after[0], uuidFromString(after[1])],
          request.direction,
        );
        const clauses = [keyset];
        if (request.connectivity !== undefined) {
          clauses.push(sql`connectivity = ${request.connectivity}`);
        }
        if (request.lifecycle !== undefined) clauses.push(sql`lifecycle = ${request.lifecycle}`);
        if (request.label !== undefined) {
          clauses.push(
            sql`EXISTS (SELECT 1 FROM json_each(runners.labels) WHERE value = ${request.label})`,
          );
        }
        const rows = yield* sql<RunnerRow>`
          SELECT ${sql.literal(COLUMNS)} FROM runners
          WHERE ${sql.and(clauses)} ${order} LIMIT ${request.limit + 1}
        `;
        return yield* buildPage(
          rows,
          request.limit,
          (page) => Effect.forEach(page, toRunner),
          (last) => encodeCursor(scope, last.name, last.id),
        );
      }),
  };
});

export const runnerRepository = make;
