/**
 * Provider instance rows and the snapshots hanging off them. Nothing here
 * decides policy - who may write, what a config means, what gets logged - it
 * only reads and writes.
 *
 * The set is a handful of rows per install, so a listing reads the whole table
 * rather than paging it.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { mintUuid, uuidFromString, uuidToString } from "../db";

/** An instance as it is stored: the definition's half is composed at read. */
export interface StoredInstance {
  readonly id: string;
  readonly providerId: string;
  readonly name: string;
  readonly config: Schema.Json;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Everything a new instance row holds. */
export interface NewInstance {
  readonly providerId: string;
  readonly name: string;
  readonly config: Schema.Json;
  readonly at: string;
}

/** The columns an edit may set. An absent one is left as it was. */
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

/** The config column is decoded rather than parsed, so a bad row is a typed failure. */
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

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /** Every instance, ordered so a listing reads the same twice. */
    list: (): Effect.Effect<ReadonlyArray<StoredInstance>, SqlError | Schema.SchemaError> =>
      Effect.flatMap(
        sql<InstanceRow>`
          SELECT ${sql.literal(INSTANCE_COLUMNS)} FROM provider_instances
          ORDER BY provider_id, id
        `,
        (rows) => Effect.forEach(rows, toInstance),
      ),

    /** One instance by id. */
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

    /** The providers that already have at least one instance. */
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

    /** Applies an edit. Only the columns the edit names are written. */
    update: (id: string, edit: InstanceEdit, at: string): Effect.Effect<void, SqlError> => {
      const sets = [sql`updated_at = ${at}`];
      if (edit.name !== undefined) sets.push(sql`name = ${edit.name}`);
      if (edit.config !== undefined) sets.push(sql`config = ${JSON.stringify(edit.config)}`);
      return Effect.asVoid(
        sql`UPDATE provider_instances SET ${sql.csv(sets)} WHERE id = ${uuidFromString(id)}`,
      );
    },

    /** Removes the instance. Its snapshots go with it, by foreign key. */
    delete: (id: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`DELETE FROM provider_instances WHERE id = ${uuidFromString(id)}`),
  };
});

/** Everything the provider service reads and writes. */
export const providerRepository = make;
