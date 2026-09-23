/**
 * Provider instance rows and their snapshots. An install has only a handful of
 * rows, so listings read the whole table.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { ModelDescriptor, type ProbeResult } from "@hercule/protocol";
import { mintUuid, uuidFromString, uuidToString } from "../db";

/** An instance as it is stored. The fields from the provider definition are added when it is read. */
export interface StoredInstance {
  readonly id: string;
  readonly providerId: string;
  readonly name: string;
  readonly config: Schema.Json;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NewInstance {
  readonly providerId: string;
  readonly name: string;
  readonly config: Schema.Json;
  readonly at: string;
}

/** The columns an update may set. An absent field leaves its column unchanged. */
export interface InstanceEdit {
  readonly name?: string;
  readonly config?: Schema.Json;
}

interface InstanceRow {
  readonly id: Uint8Array;
  readonly provider_id: string;
  readonly name: string;
  readonly config: string;
  readonly created_at: string;
  readonly updated_at: string;
}

const INSTANCE_COLUMNS = "id, provider_id, name, config, created_at, updated_at";

/** The config column is decoded with a schema rather than `JSON.parse`, so a bad row fails with a typed error. */
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));

const toInstance = (row: InstanceRow): Effect.Effect<StoredInstance, Schema.SchemaError> =>
  Effect.map(decodeConfig(row.config), (config) => ({
    id: uuidToString(row.id),
    providerId: row.provider_id,
    name: row.name,
    config,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

export interface StoredSnapshot {
  readonly instanceId: string;
  readonly runnerId: string;
  readonly probedAt: string;
  readonly harnessVersion: string | null;
  readonly auth: ProbeResult["auth"];
  readonly models: ProbeResult["models"];
}

interface SnapshotRow {
  readonly instance_id: Uint8Array;
  readonly runner_id: Uint8Array;
  readonly probed_at: string;
  readonly harness_version: string | null;
  readonly auth_status: string;
  readonly auth_identity: string | null;
  readonly auth_plan_label: string | null;
  readonly auth_backend: string | null;
  readonly auth_message: string | null;
  readonly models: string;
}

const SNAPSHOT_COLUMNS =
  "instance_id, runner_id, probed_at, harness_version, auth_status, auth_identity, " +
  "auth_plan_label, auth_backend, auth_message, models";

const decodeModels = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(ModelDescriptor)),
);

/** Converts a null column to an absent key, because the wire schema has no nulls. */
const toProbeAuth = (row: SnapshotRow): ProbeResult["auth"] => ({
  status: row.auth_status as ProbeResult["auth"]["status"],
  ...(row.auth_identity === null ? {} : { identity: row.auth_identity }),
  ...(row.auth_plan_label === null ? {} : { planLabel: row.auth_plan_label }),
  ...(row.auth_backend === null ? {} : { backend: row.auth_backend }),
  ...(row.auth_message === null ? {} : { message: row.auth_message }),
});

const toSnapshot = (row: SnapshotRow): Effect.Effect<StoredSnapshot, Schema.SchemaError> =>
  Effect.map(decodeModels(row.models), (models) => ({
    instanceId: uuidToString(row.instance_id),
    runnerId: uuidToString(row.runner_id),
    probedAt: row.probed_at,
    harnessVersion: row.harness_version,
    auth: toProbeAuth(row),
    models,
  }));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /** Returns every instance, in a stable order so two listings match. */
    list: (): Effect.Effect<ReadonlyArray<StoredInstance>, SqlError | Schema.SchemaError> =>
      Effect.flatMap(
        sql<InstanceRow>`
          SELECT ${sql.literal(INSTANCE_COLUMNS)} FROM provider_instances
          ORDER BY provider_id, id
        `,
        (rows) => Effect.forEach(rows, toInstance),
      ),

    one: (
      id: string,
    ): Effect.Effect<Option.Option<StoredInstance>, SqlError | Schema.SchemaError> =>
      Effect.flatMap(
        sql<InstanceRow>`
          SELECT ${sql.literal(INSTANCE_COLUMNS)} FROM provider_instances
          WHERE id = ${uuidFromString(id)}
        `,
        (rows) =>
          Option.match(Option.fromNullishOr(rows[0]), {
            onNone: () => Effect.succeed(Option.none<StoredInstance>()),
            onSome: (row) => Effect.map(toInstance(row), Option.some),
          }),
      ),

    providersWithInstance: (): Effect.Effect<ReadonlySet<string>, SqlError> =>
      Effect.map(
        sql<{
          readonly provider_id: string;
        }>`SELECT DISTINCT provider_id FROM provider_instances`,
        (rows) => new Set(rows.map((row) => row.provider_id)),
      ),

    insert: (instance: NewInstance): Effect.Effect<StoredInstance, SqlError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        yield* sql`
          INSERT INTO provider_instances (id, provider_id, name, config, created_at, updated_at)
          VALUES (${id}, ${instance.providerId}, ${instance.name},
                  ${JSON.stringify(instance.config)}, ${instance.at}, ${instance.at})
        `;
        return {
          id: uuidToString(id),
          providerId: instance.providerId,
          name: instance.name,
          config: instance.config,
          createdAt: instance.at,
          updatedAt: instance.at,
        };
      }),

    update: (id: string, edit: InstanceEdit, at: string): Effect.Effect<void, SqlError> => {
      const sets = [sql`updated_at = ${at}`];
      if (edit.name !== undefined) sets.push(sql`name = ${edit.name}`);
      if (edit.config !== undefined) sets.push(sql`config = ${JSON.stringify(edit.config)}`);
      return Effect.asVoid(
        sql`UPDATE provider_instances SET ${sql.csv(sets)} WHERE id = ${uuidFromString(id)}`,
      );
    },

    /** Deletes the instance. Its snapshots are deleted with it, by the foreign key. */
    delete: (id: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`DELETE FROM provider_instances WHERE id = ${uuidFromString(id)}`),

    snapshots: (): Effect.Effect<ReadonlyArray<StoredSnapshot>, SqlError | Schema.SchemaError> =>
      Effect.flatMap(
        sql<SnapshotRow>`
          SELECT ${sql.literal(SNAPSHOT_COLUMNS)} FROM capability_snapshots
          ORDER BY instance_id, runner_id
        `,
        (rows) => Effect.forEach(rows, toSnapshot),
      ),

    snapshotsOf: (
      instanceId: string,
    ): Effect.Effect<ReadonlyArray<StoredSnapshot>, SqlError | Schema.SchemaError> =>
      Effect.flatMap(
        sql<SnapshotRow>`
          SELECT ${sql.literal(SNAPSHOT_COLUMNS)} FROM capability_snapshots
          WHERE instance_id = ${uuidFromString(instanceId)}
          ORDER BY runner_id
        `,
        (rows) => Effect.forEach(rows, toSnapshot),
      ),

    /**
     * Stores a runner's probe result for an instance, replacing the previous
     * one. A snapshot caches the last probe result, and keeps no history.
     */
    recordSnapshot: (
      instanceId: string,
      runnerId: string,
      result: ProbeResult,
      at: string,
    ): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        INSERT INTO capability_snapshots (${sql.literal(SNAPSHOT_COLUMNS)})
        VALUES (${uuidFromString(instanceId)}, ${uuidFromString(runnerId)}, ${at},
                ${result.harnessVersion}, ${result.auth.status}, ${result.auth.identity ?? null},
                ${result.auth.planLabel ?? null}, ${result.auth.backend ?? null},
                ${result.auth.message ?? null}, ${JSON.stringify(result.models)})
        ON CONFLICT (instance_id, runner_id) DO UPDATE SET
          probed_at = excluded.probed_at,
          harness_version = excluded.harness_version,
          auth_status = excluded.auth_status,
          auth_identity = excluded.auth_identity,
          auth_plan_label = excluded.auth_plan_label,
          auth_backend = excluded.auth_backend,
          auth_message = excluded.auth_message,
          models = excluded.models
      `),
  };
});

export const providerRepository = make;
