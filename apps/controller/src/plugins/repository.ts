/**
 * The repository for the three plugin tables. There are only a handful of
 * plugins, so both listings read the whole table. The two JSON columns are
 * decoded with a schema rather than parsed, so an unreadable row is a typed
 * failure and not a defect in the middle of a listing.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

/** The user's settings for one plugin. */
export interface PluginState {
  readonly enabled: boolean;
  readonly config: Schema.Json;
}

/** One catalog row, as it is read back. */
export interface Contribution {
  readonly extensionPoint: string;
  readonly id: string;
  readonly definition: Schema.Json;
  /**
   * Whether the owning plugin is enabled. A contribution stays in the catalog
   * while its plugin is disabled, so a picker can show what is missing. This
   * is only the stored flag: a plugin whose teardown failed still reads
   * `true`, so a resolver must also check the host's status.
   */
  readonly ownerEnabled: boolean;
}

/** A catalog row to write. `definition` is typed loosely: the host has already decoded it, so it is JSON. */
export interface NewContribution {
  readonly owner: string;
  readonly extensionPoint: string;
  readonly id: string;
  readonly definition: unknown;
}

/** The `config` and `definition` columns: JSON text holding a JSON value. */
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));

/**
 * Returns a plugin's stored state, or dies when it has none. Boot writes the
 * row in the same transaction that lists the plugin, so a missing row means
 * the database is broken.
 */
export const readStoredStateOrDie = (
  state: PluginState | undefined,
  id: string,
): Effect.Effect<PluginState> =>
  state === undefined
    ? Effect.die(new Error(`The plugin ${id} has no stored row.`))
    : Effect.succeed(state);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /** Inserts a row for each registry plugin that has none. Existing rows keep the user's settings. */
    ensure: (ids: ReadonlyArray<string>, at: string): Effect.Effect<void, SqlError> =>
      Effect.forEach(
        ids,
        (id) => sql`
          INSERT INTO plugins (id, enabled, config, created_at, updated_at)
          VALUES (${id}, 1, '{}', ${at}, ${at})
          ON CONFLICT (id) DO NOTHING
        `,
        { discard: true },
      ),

    /** Stores whether one plugin is enabled. */
    setEnabled: (id: string, enabled: boolean, at: string): Effect.Effect<void, SqlError> =>
      sql`UPDATE plugins SET enabled = ${enabled ? 1 : 0}, updated_at = ${at} WHERE id = ${id}`.pipe(
        Effect.asVoid,
      ),

    /** Stores a config the plugin's own schema has already accepted. */
    setConfig: (id: string, config: Schema.Json, at: string): Effect.Effect<void, SqlError> =>
      sql`
        UPDATE plugins SET config = ${JSON.stringify(config)}, updated_at = ${at} WHERE id = ${id}
      `.pipe(Effect.asVoid),

    /** Returns the user's settings for every plugin, by plugin id. */
    states: (): Effect.Effect<ReadonlyMap<string, PluginState>, SqlError | Schema.SchemaError> =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly id: string;
          readonly enabled: number;
          readonly config: string;
        }>`SELECT id, enabled, config FROM plugins`;
        const states = new Map<string, PluginState>();
        for (const row of rows) {
          states.set(row.id, {
            enabled: row.enabled === 1,
            config: yield* decodeJson(row.config),
          });
        }
        return states;
      }),

    /** Returns the user's settings for one plugin. */
    state: (id: string): Effect.Effect<PluginState, SqlError | Schema.SchemaError> =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly enabled: number;
          readonly config: string;
        }>`SELECT enabled, config FROM plugins WHERE id = ${id}`;
        const row = rows[0];
        return yield* readStoredStateOrDie(
          row === undefined
            ? undefined
            : { enabled: row.enabled === 1, config: yield* decodeJson(row.config) },
          id,
        );
      }),

    /**
     * Replaces the whole catalog. Registration has no side effects, so what
     * this boot registered is complete, and there is nothing to diff against.
     */
    rewriteCatalog: (
      contributions: ReadonlyArray<NewContribution>,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM plugin_contributions`;
        yield* Effect.forEach(
          contributions,
          (contribution) => sql`
            INSERT INTO plugin_contributions (owner, extension_point, id, definition)
            VALUES (
              ${contribution.owner}, ${contribution.extensionPoint}, ${contribution.id},
              ${JSON.stringify(contribution.definition)}
            )
          `,
          { discard: true },
        );
      }),

    /** Returns every catalog row by owner, in a fixed order, so a listing is the same on every boot. */
    contributions: (): Effect.Effect<
      ReadonlyMap<string, ReadonlyArray<Contribution>>,
      SqlError | Schema.SchemaError
    > =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly owner: string;
          readonly extension_point: string;
          readonly id: string;
          readonly definition: string;
          readonly owner_enabled: number;
        }>`
          SELECT c.owner, c.extension_point, c.id, c.definition,
                 -- \`core\` owns contributions and has no row here, because it is
                 -- not a plugin and is never disabled.
                 COALESCE(p.enabled, 1) AS owner_enabled
          FROM plugin_contributions c
          LEFT JOIN plugins p ON p.id = c.owner
          ORDER BY c.owner, c.extension_point, c.id
        `;
        const byOwner = new Map<string, Array<Contribution>>();
        for (const row of rows) {
          const owned = byOwner.get(row.owner) ?? [];
          owned.push({
            extensionPoint: row.extension_point,
            id: row.id,
            definition: yield* decodeJson(row.definition),
            ownerEnabled: row.owner_enabled === 1,
          });
          byOwner.set(row.owner, owned);
        }
        return byOwner;
      }),

    /** Returns one plugin's stored value under a key, or `none` when nothing is stored. */
    kvGet: (
      pluginId: string,
      key: string,
    ): Effect.Effect<Option.Option<Schema.Json>, SqlError | Schema.SchemaError> =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly value: string }>`
          SELECT value FROM plugin_kv WHERE plugin_id = ${pluginId} AND key = ${key}
        `;
        const row = rows[0];
        return row === undefined ? Option.none() : Option.some(yield* decodeJson(row.value));
      }),

    kvSet: (pluginId: string, key: string, value: Schema.Json): Effect.Effect<void, SqlError> =>
      sql`
        INSERT INTO plugin_kv (plugin_id, key, value)
        VALUES (${pluginId}, ${key}, ${JSON.stringify(value)})
        ON CONFLICT (plugin_id, key) DO UPDATE SET value = excluded.value
      `.pipe(Effect.asVoid),

    kvDelete: (pluginId: string, key: string): Effect.Effect<void, SqlError> =>
      sql`DELETE FROM plugin_kv WHERE plugin_id = ${pluginId} AND key = ${key}`.pipe(Effect.asVoid),

    /** Returns the keys one plugin stores, sorted, so a listing is always in the same order. */
    kvKeys: (pluginId: string): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      sql<{ readonly key: string }>`
        SELECT key FROM plugin_kv WHERE plugin_id = ${pluginId} ORDER BY key
      `.pipe(Effect.map((rows) => rows.map((row) => row.key))),

    /** Deletes everything one plugin stored. This is what "Reset plugin state" does. */
    kvWipe: (pluginId: string): Effect.Effect<void, SqlError> =>
      sql`DELETE FROM plugin_kv WHERE plugin_id = ${pluginId}`.pipe(Effect.asVoid),
  };
});

export const pluginRepository = make;
