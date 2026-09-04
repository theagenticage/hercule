/**
 * The settings store: one table for both settings scopes (spec 04, What is in
 * the store).
 *
 * `controller` rows are the controller's operational settings, edited in
 * Settings > System (spec 14) and seeded at first run. `user` rows are the user
 * settings store of spec 11 section 2, keyed by user id from day one; no user
 * exists until `setup.complete`, so those rows default lazily and this module
 * declares no keys for them yet.
 *
 * Values are JSON text, and every key carries an Effect Schema, so a read that
 * cannot produce the key's type is an error rather than a value the caller
 * misinterprets.
 */
import { Clock, Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

/** A retention window or a snapshot count, in whole days or whole snapshots. */
const PositiveDays = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0));

/** A time of day in the user timezone setting, `HH:MM` on a 24-hour clock. */
const TimeOfDay = Schema.String.check(Schema.isPattern(/^([01]\d|2[0-3]):[0-5]\d$/));

/**
 * The keys each scope defines, with the schema of the value. The typed API
 * covers the scopes listed here; adding the user settings store is adding a
 * `user` block (spec 11 section 2).
 */
const SETTING_SCHEMAS = {
  controller: {
    /** TTL for the event log and per-session streams, in days (spec 04). */
    "retention.events": PositiveDays,
    /** Minimum retention for security events and actor-stamped mutations, in days. */
    "retention.security": PositiveDays,
    /** Retention for conversation messages, in days (spec 12 section 2). */
    "retention.conversations": PositiveDays,
    /** When the daily backup snapshot runs, in the user timezone setting. */
    "backup.time": TimeOfDay,
    /** How many daily snapshots to keep (spec 04, Backups). */
    "backup.keep": PositiveDays,
  },
  user: {
    /** The IANA zone the user reads times in, chosen during setup (spec 15 section 7). */
    timezone: Schema.NonEmptyString,
  },
} as const;

/** A scope whose keys are declared here, and so are typed on `get` and `setIfAbsent`. */
export type TypedScope = keyof typeof SETTING_SCHEMAS;

export type SettingKey<S extends TypedScope> = keyof (typeof SETTING_SCHEMAS)[S] & string;

export type SettingValue<S extends TypedScope, K extends SettingKey<S>> = Schema.Schema.Type<
  (typeof SETTING_SCHEMAS)[S][K]
>;

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
