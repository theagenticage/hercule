/**
 * The settings store: one table for both settings scopes (spec 04, What is in
 * the store).
 *
 * `controller` rows are the controller's operational settings, edited in
 * Settings > System (spec 14) and seeded at first run. `user` rows are the user
 * settings store of spec 11 section 2, keyed by user id from day one.
 *
 * The keys and what they hold are declared once, in the contract
 * (`SETTING_VALUES`): the same map shapes `settings.read` on the wire and the
 * JSON in the `value` column, so a key cannot mean one thing to a caller and
 * another to a row. Values are JSON text, and every key carries an Effect
 * Schema, so a read that cannot produce the key's type is an error rather than
 * a value the caller misinterprets.
 */
import { Clock, Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { SETTING_VALUES } from "@hydra/contract";

/** The keys each scope defines, with the schema of the value. */
const SETTING_SCHEMAS = SETTING_VALUES;

/** A scope whose keys are declared, and so are typed on `get`, `set` and `setIfAbsent`. */
export type TypedScope = keyof typeof SETTING_SCHEMAS;

export type SettingKey<S extends TypedScope> = keyof (typeof SETTING_SCHEMAS)[S] & string;

export type SettingValue<S extends TypedScope, K extends SettingKey<S>> = Schema.Schema.Type<
  (typeof SETTING_SCHEMAS)[S][K]
>;

/** Everything one scope holds: the keys that are set, and nothing for the rest. */
export type ScopeSettings<S extends TypedScope> = {
  readonly [K in SettingKey<S>]?: SettingValue<S, K>;
};

/** A setting is absent, or holds a value its schema rejects. */
export class SettingError extends Schema.TaggedError<SettingError>()("SettingError", {
  scope: Schema.String,
  key: Schema.String,
  message: Schema.String,
}) {}

/**
 * The stored codec for one key: its declared schema wrapped in the JSON text
 * the `value` column holds. The lookup is by string, so the caller's typed key
 * is what keeps the value type honest.
 */
const schemaFor = (scope: TypedScope, key: string): Schema.Codec<unknown, string> =>
  Schema.fromJsonString((SETTING_SCHEMAS[scope] as Record<string, Schema.Codec<unknown>>)[key]!);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /** Reads one declared setting, decoded to the key's type. */
    get: <S extends TypedScope, K extends SettingKey<S>>(
      scope: S,
      key: K,
    ): Effect.Effect<SettingValue<S, K>, SettingError | SqlError> =>
      sql<{
        readonly value: string;
      }>`SELECT value FROM settings WHERE scope = ${scope} AND key = ${key}`.pipe(
        Effect.flatMap((rows) => {
          const row = rows[0];
          if (row === undefined) {
            return Effect.fail(new SettingError({ scope, key, message: "is not set" }));
          }
          return Schema.decodeUnknownEffect(schemaFor(scope, key))(row.value).pipe(
            Effect.mapError((error) => new SettingError({ scope, key, message: error.message })),
          );
        }),
        Effect.map((value) => value as SettingValue<S, K>),
      ),

    /**
     * Every key that is set in one scope, decoded to its declared type. A key
     * nobody has set is absent rather than defaulted, so the default lives in
     * one place: whoever reads the key (spec 11 section 2).
     *
     * A row whose key this build does not declare - what a downgrade leaves
     * behind - is left out and said so in the log, rather than failing the
     * whole read over a key the caller never asked about.
     */
    all: <S extends TypedScope>(
      scope: S,
    ): Effect.Effect<ScopeSettings<S>, SettingError | SqlError> =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          readonly key: string;
          readonly value: string;
        }>`SELECT key, value FROM settings WHERE scope = ${scope} ORDER BY key`;

        const entries: Array<readonly [string, unknown]> = [];
        for (const row of rows) {
          if (!Object.hasOwn(SETTING_SCHEMAS[scope], row.key)) {
            yield* Effect.logWarning(`Ignoring the ${scope} setting ${row.key}: no such key.`);
            continue;
          }
          const value = yield* Schema.decodeUnknownEffect(schemaFor(scope, row.key))(
            row.value,
          ).pipe(
            Effect.mapError(
              (error) => new SettingError({ scope, key: row.key, message: error.message }),
            ),
          );
          entries.push([row.key, value] as const);
        }
        // The keys are the scope's own and each value came from that key's
        // schema, which is exactly what the mapped type says; TypeScript cannot
        // follow the loop that far.
        return Object.fromEntries(entries) as ScopeSettings<S>;
      }),

    /** Writes a setting, replacing whatever was there. */
    set: <S extends TypedScope, K extends SettingKey<S>>(
      scope: S,
      key: K,
      value: SettingValue<S, K>,
    ): Effect.Effect<void, SettingError | SqlError> =>
      Effect.gen(function* () {
        const json = yield* Schema.encodeUnknownEffect(schemaFor(scope, key))(value).pipe(
          Effect.mapError((error) => new SettingError({ scope, key, message: error.message })),
        );
        const at = new Date(yield* Clock.currentTimeMillis).toISOString();
        yield* sql`
          INSERT INTO settings (scope, key, value, updated_at)
          VALUES (${scope}, ${key}, ${json}, ${at})
          ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `;
      }),

    /**
     * Writes a setting only when it is absent. Seeding a default never
     * overwrites what the user has chosen (spec 15 section 7).
     */
    setIfAbsent: <S extends TypedScope, K extends SettingKey<S>>(
      scope: S,
      key: K,
      value: SettingValue<S, K>,
    ): Effect.Effect<void, SettingError | SqlError> =>
      Effect.gen(function* () {
        const json = yield* Schema.encodeUnknownEffect(schemaFor(scope, key))(value).pipe(
          Effect.mapError((error) => new SettingError({ scope, key, message: error.message })),
        );
        const at = new Date(yield* Clock.currentTimeMillis).toISOString();
        yield* sql`
          INSERT OR IGNORE INTO settings (scope, key, value, updated_at)
          VALUES (${scope}, ${key}, ${json}, ${at})
        `;
      }),
  };
});

/** The settings repository (ADR 0031: every operation is a service method). */
export class Settings extends Context.Service<Settings, Effect.Success<typeof make>>()(
  "hydra/controller/settings/Settings",
) {}

export const SettingsLayer: Layer.Layer<Settings, never, SqlClient.SqlClient> = Layer.effect(
  Settings,
  make,
);
