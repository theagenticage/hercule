/**
 * The three plugin tables. Nothing here decides policy: which plugins exist is
 * the registry's answer and what a boot found is the host's.
 *
 * The set of plugins is fixed by the binary and is a handful of rows, so both
 * listings read the whole table rather than filtering or paging.
 *
 * The two JSON columns are decoded rather than parsed, so a row this build
 * cannot read is a typed failure the caller can answer with, not a defect
 * thrown from the middle of a listing.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

/** What the user decided about one plugin. */
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
   * Whether the plugin that contributed it may run. A contribution stays in the
   * catalog while its owner is disabled, so a picker can say what is missing
   * rather than silently losing the entry.
   */
  readonly ownerEnabled: boolean;
}

/**
 * One catalog row, as a boot writes it. The definition is typed loosely because
 * the host has already decoded it against its contribution schema: what reaches
 * here is JSON by construction.
 */
export interface NewContribution {
  readonly owner: string;
  readonly extensionPoint: string;
  readonly id: string;
  readonly definition: unknown;
}

/** The `config` and `definition` columns: JSON text holding a JSON value. */
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /**
     * Gives every plugin in the registry a row, enabled and unconfigured, and
     * leaves the rows already there alone: those hold what the user decided.
     */
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

    /** Records what the user decided about one plugin. */
    setEnabled: (id: string, enabled: boolean, at: string): Effect.Effect<void, SqlError> =>
      sql`UPDATE plugins SET enabled = ${enabled ? 1 : 0}, updated_at = ${at} WHERE id = ${id}`.pipe(
        Effect.asVoid,
      ),

    /** Stores a config the plugin's own schema has already accepted. */
    setConfig: (id: string, config: Schema.Json, at: string): Effect.Effect<void, SqlError> =>
      sql`
        UPDATE plugins SET config = ${JSON.stringify(config)}, updated_at = ${at} WHERE id = ${id}
      `.pipe(Effect.asVoid),

    /** What the user decided, per plugin id. */
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

    /**
     * Replaces the whole catalog. Registration is pure, so what this boot
     * produced is the whole truth and there is nothing to diff against.
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

    /**
     * The catalog, grouped by the owner that contributed each row. Ordered, so
     * a listing reads the same on every boot however the rows were written.
     */
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

    /** One plugin's stored value under a key, or nothing stored under it. */
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

    /** The keys one plugin stores, ordered so a listing reads the same twice. */
    kvKeys: (pluginId: string): Effect.Effect<ReadonlyArray<string>, SqlError> =>
      sql<{ readonly key: string }>`
        SELECT key FROM plugin_kv WHERE plugin_id = ${pluginId} ORDER BY key
      `.pipe(Effect.map((rows) => rows.map((row) => row.key))),

    /** Everything one plugin stored. What Reset plugin state means. */
    kvWipe: (pluginId: string): Effect.Effect<void, SqlError> =>
      sql`DELETE FROM plugin_kv WHERE plugin_id = ${pluginId}`.pipe(Effect.asVoid),
  };
});

export const pluginRepository = make;
