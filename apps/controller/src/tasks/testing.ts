/**
 * The harness for tests of the Task service on real rows, where the Task links
 * External Entities: the service with its ports answered, a Connection, stored
 * records to arrange, an entity write played as the ingest plays it, and a read
 * of the facts written.
 */
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import type { EntityLifecycle, ExternalRef } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { mintUuid, uuidFromString, uuidToString, withTransaction } from "../db";
import { TestDatabase } from "../db/testing";
import { AuditLogLayer, PlatformEventsLayer } from "../events";
import { NotifierLayer } from "../notifications";
import { TaskServicePortsLayer } from "../daemon/tasks";
import { TaskService, TaskServiceLayer } from "./index";

/**
 * The Task service on a fresh migrated database, with its ports answered. It
 * also provides the database, the audit log, the Platform Events and the
 * notifier, so a test can build another service on it.
 */
export const TaskTestLayer = TaskServiceLayer.pipe(
  Layer.provideMerge(NotifierLayer),
  Layer.provideMerge(TaskServicePortsLayer),
  Layer.provideMerge(Layer.mergeAll(AuditLogLayer, PlatformEventsLayer)),
  Layer.provideMerge(TestDatabase),
);

export const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

export const run = <A, E>(effect: Effect.Effect<A, E, TaskService | SqlClient.SqlClient>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(CurrentActor, USER),
      Effect.provide(TaskTestLayer),
      Effect.provide(TestClock.layer()),
    ),
  );

export const A_MINUTE = 60_000;
export const PLUGIN = "northwind";
export const CONNECTION = "0190c000-0000-7000-8000-0000000000a1";
export const PULL_REQUEST = "northwind/pull-request";
export const PULL_REQUEST_PREFIX = "northwind:pr:";
export const REPOSITORY_KIND = "northwind/repository";

export const pr = (number: number): ExternalRef => `${PULL_REQUEST_PREFIX}${number}`;
export const REPOSITORY: ExternalRef = "northwind:repo:web";

/** The state of a stored record the tests arrange. */
export interface ArrangedRecord {
  readonly ref: string;
  readonly kind?: string;
  readonly pace?: "fast" | "slow" | "context";
  readonly completeness?: "full" | "partial";
  readonly lifecycle?: EntityLifecycle | null;
  /** The thing's short name in its source, such as `#6221`. */
  readonly identifier?: string;
  /** The label of the thing's status, such as `Merged`. */
  readonly statusLabel?: string;
  /** How a Connection reads the record. `none` means no Connection observes it. */
  readonly access?: "ok" | "inaccessible" | "none";
}

/** Writes the Connection that observes the records of the tests. */
export const arrangeConnection = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* withTransaction(
    sql,
    Effect.gen(function* () {
      yield* sql`INSERT INTO plugins (id, enabled, config, created_at, updated_at)
        VALUES (${PLUGIN}, 1, '{}', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO connections (id, plugin_id, type, label, display_name, account_id,
          status, labels, config, created_at, updated_at)
        VALUES (${uuidFromString(CONNECTION)}, ${PLUGIN}, ${`${PLUGIN}/account`}, 'a', 'a', 'a',
          'connected', '[]', '{}', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')`;
    }),
  );
});

/** Declares the kinds of the plugin in the stored catalog, as boot writes them. */
export const declareKinds = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* withTransaction(
    sql,
    sql`INSERT INTO plugin_contributions (owner, extension_point, id, definition)
      VALUES (${PLUGIN}, 'event-source', ${`${PLUGIN}/${PLUGIN}`}, ${JSON.stringify({
        entityKinds: [
          { kind: PULL_REQUEST, refPrefix: PULL_REQUEST_PREFIX, classification: "work" },
          { kind: REPOSITORY_KIND, refPrefix: "northwind:repo:", classification: "context" },
        ],
      })})`,
  );
});

/** Writes the record of a thing, and the observation that decides whether it can be read. Run it in a transaction. */
const writeRecord = (record: ArrangedRecord) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const kind = record.kind ?? PULL_REQUEST;
    // A partial record has no pace yet: only a full observation sets it.
    const pace =
      record.completeness === "partial"
        ? null
        : (record.pace ?? (kind === REPOSITORY_KIND ? "context" : "fast"));
    yield* sql`
      INSERT INTO external_entities
        (id, ref, kind, noun, pace, completeness, title, lifecycle, identifier, status,
         first_observed_at, updated_at)
      VALUES (${mintUuid()}, ${record.ref}, ${kind}, 'Pull request', ${pace},
              ${record.completeness ?? "full"}, 'A change', ${record.lifecycle ?? null},
              ${record.identifier ?? null},
              ${
                record.statusLabel === undefined
                  ? null
                  : JSON.stringify({ shape: "join", tone: "quiet", label: record.statusLabel })
              },
              '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z')`;
    if ((record.access ?? "ok") !== "none") {
      yield* sql`
        INSERT INTO external_entity_observations (ref, connection_id, access)
        VALUES (${record.ref}, ${uuidFromString(CONNECTION)}, ${record.access ?? "ok"})`;
    }
  });

/** Stores records in their own transaction. */
export const arrange = (...records: ReadonlyArray<ArrangedRecord>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* withTransaction(sql, Effect.forEach(records, writeRecord, { discard: true }));
  });

/**
 * Plays an entity write as the ingest does: snapshots `refs`, runs `change`,
 * and records the facts, in one transaction.
 */
export const writeEntities = (
  refs: ReadonlyArray<string>,
  change: Effect.Effect<void, unknown, SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tasks = yield* TaskService;
    yield* TestClock.adjust(A_MINUTE);
    yield* withTransaction(sql, tasks.recordEntityFactsAround(refs, change));
  });

export const setLifecycle = (ref: string, lifecycle: EntityLifecycle) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE external_entities SET lifecycle = ${lifecycle} WHERE ref = ${ref}`;
  });

export const setAccess = (ref: string, access: "ok" | "inaccessible") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE external_entity_observations SET access = ${access} WHERE ref = ${ref}`;
  });

/** Creates a Task that links `refs`, a minute after the last write. */
export const createTaskLinking = (title: string, ...refs: ReadonlyArray<ExternalRef>) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(A_MINUTE);
    const tasks = yield* TaskService;
    return yield* tasks.create({
      title,
      description: "",
      provenance: refs.map((ref) => ({ ref })),
    });
  });

export interface StoredFact {
  readonly taskId: string;
  readonly ref: string;
  readonly lifecycle: string;
  readonly previousLifecycle: string | null;
}

/** Returns every fact in the table, in order. */
export const readFacts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly id: number;
    readonly task_id: Uint8Array;
    readonly ref: string;
    readonly lifecycle: string;
    readonly previous_lifecycle: string | null;
  }>`SELECT id, task_id, ref, lifecycle, previous_lifecycle FROM task_entity_facts ORDER BY id`;
  return rows.map((row): StoredFact & { readonly id: number } => ({
    id: row.id,
    taskId: uuidToString(row.task_id),
    ref: row.ref,
    lifecycle: row.lifecycle,
    previousLifecycle: row.previous_lifecycle,
  }));
});
