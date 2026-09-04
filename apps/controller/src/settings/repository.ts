/**
 * The settings store: two tables, one per scope.
 *
 * `settings` holds the controller's operational settings, edited in Settings >
 * System and seeded at first run. `user_settings` holds the user settings,
 * keyed by user id from day one, so a second user is a `WHERE` clause rather
 * than a table rebuild.
 *
 * The keys and what they hold are declared once, in the contract
 * (`SETTING_VALUES`): the same map shapes `settings.read` on the wire and the
 * JSON in the `value` column, so a key cannot mean one thing to a caller and
 * another to a row. Values are JSON text, and every key carries an Effect
 * Schema, so a read that cannot produce the key's type is an error rather than
 * a value the caller misinterprets.
 */
import { Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { SETTING_VALUES } from "@hydra/contract";
import { nowIso, uuidFromString } from "../db";

/** The keys each scope defines, with the schema of the value. */
const SETTING_SCHEMAS = SETTING_VALUES;

/** A scope whose keys are declared, and so are typed on every read and write. */
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

/** One stored value, decoded to the key's declared type. */
const decode = (
  scope: TypedScope,
  key: string,
  value: string,
): Effect.Effect<unknown, SettingError> =>
  Schema.decodeUnknownEffect(schemaFor(scope, key))(value).pipe(
    Effect.mapError((error) => new SettingError({ scope, key, message: error.message })),
  );

/** One value, encoded to the JSON text the `value` column holds. */
const encode = (
  scope: TypedScope,
  key: string,
  value: unknown,
): Effect.Effect<string, SettingError> =>
  Schema.encodeUnknownEffect(schemaFor(scope, key))(value).pipe(
    Effect.mapError((error) => new SettingError({ scope, key, message: error.message })),
  );

/**
 * Every row of one scope, decoded to its key's declared type.
 *
 * A row whose key this build does not declare - what a downgrade leaves behind
 * - is left out and said so in the log, rather than failing the whole read over
 * a key the caller never asked about.
 */
const decodeRows = <S extends TypedScope>(
  scope: S,
  rows: ReadonlyArray<{ readonly key: string; readonly value: string }>,
): Effect.Effect<ScopeSettings<S>, SettingError> =>
  Effect.gen(function* () {
    const entries: Array<readonly [string, unknown]> = [];
    for (const row of rows) {
      if (!Object.hasOwn(SETTING_SCHEMAS[scope], row.key)) {
        yield* Effect.logWarning(`Ignoring the ${scope} setting ${row.key}: no such key.`);
        continue;
      }
      entries.push([row.key, yield* decode(scope, row.key, row.value)] as const);
    }
    // The keys are the scope's own and each value came from that key's schema,
    // which is exactly what the mapped type says; TypeScript cannot follow the
    // loop that far.
    return Object.fromEntries(entries) as ScopeSettings<S>;
  });

/** The row shape both tables answer a listing with. */
interface KeyValueRow {
  readonly key: string;
  readonly value: string;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /** Reads one controller setting, decoded to the key's type. */
    get: <K extends SettingKey<"controller">>(
      key: K,
    ): Effect.Effect<SettingValue<"controller", K>, SettingError | SqlError> =>
      sql<KeyValueRow>`
        SELECT key, value FROM settings WHERE scope = 'controller' AND key = ${key}
      `.pipe(
        Effect.flatMap((rows) => {
          const row = rows[0];
          if (row === undefined) {
            return Effect.fail(
              new SettingError({ scope: "controller", key, message: "is not set" }),
            );
          }
          return decode("controller", key, row.value);
        }),
        Effect.map((value) => value as SettingValue<"controller", K>),
      ),

    /**
     * Every controller key that is set, decoded to its declared type. A key
     * nobody has set is absent rather than defaulted, so the default lives in
     * one place: whoever reads the key.
     */
    all: (): Effect.Effect<ScopeSettings<"controller">, SettingError | SqlError> =>
      Effect.flatMap(
        sql<KeyValueRow>`SELECT key, value FROM settings WHERE scope = 'controller' ORDER BY key`,
        (rows) => decodeRows("controller", rows),
      ),

    /** Writes a controller setting, replacing whatever was there. */
    set: <K extends SettingKey<"controller">>(
      key: K,
      value: SettingValue<"controller", K>,
    ): Effect.Effect<void, SettingError | SqlError> =>
      Effect.gen(function* () {
        const json = yield* encode("controller", key, value);
        const at = yield* nowIso;
        yield* sql`
          INSERT INTO settings (scope, key, value, updated_at)
          VALUES ('controller', ${key}, ${json}, ${at})
          ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `;
      }),

    /**
     * Writes a controller setting only when it is absent. Seeding a default
     * never overwrites what the user has chosen.
     */
    setIfAbsent: <K extends SettingKey<"controller">>(
      key: K,
      value: SettingValue<"controller", K>,
    ): Effect.Effect<void, SettingError | SqlError> =>
      Effect.gen(function* () {
        const json = yield* encode("controller", key, value);
        const at = yield* nowIso;
        yield* sql`
          INSERT OR IGNORE INTO settings (scope, key, value, updated_at)
          VALUES ('controller', ${key}, ${json}, ${at})
        `;
      }),

    /** Reads one of a user's settings, decoded to the key's type. */
    getForUser: <K extends SettingKey<"user">>(
      userId: string,
      key: K,
    ): Effect.Effect<SettingValue<"user", K>, SettingError | SqlError> =>
      sql<KeyValueRow>`
        SELECT key, value FROM user_settings
        WHERE user_id = ${uuidFromString(userId)} AND key = ${key}
      `.pipe(
        Effect.flatMap((rows) => {
          const row = rows[0];
          if (row === undefined) {
            return Effect.fail(new SettingError({ scope: "user", key, message: "is not set" }));
          }
          return decode("user", key, row.value);
        }),
        Effect.map((value) => value as SettingValue<"user", K>),
      ),

    /** Every key one user has set, decoded to its declared type. */
    allForUser: (userId: string): Effect.Effect<ScopeSettings<"user">, SettingError | SqlError> =>
      Effect.flatMap(
        sql<KeyValueRow>`
          SELECT key, value FROM user_settings
          WHERE user_id = ${uuidFromString(userId)} ORDER BY key
        `,
        (rows) => decodeRows("user", rows),
      ),

    /** Writes one of a user's settings, replacing whatever was there. */
    setForUser: <K extends SettingKey<"user">>(
      userId: string,
      key: K,
      value: SettingValue<"user", K>,
    ): Effect.Effect<void, SettingError | SqlError> =>
      Effect.gen(function* () {
        const json = yield* encode("user", key, value);
        const at = yield* nowIso;
        yield* sql`
          INSERT INTO user_settings (user_id, key, value, updated_at)
          VALUES (${uuidFromString(userId)}, ${key}, ${json}, ${at})
          ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `;
      }),
  };
});

/** The settings repository. */
export class Settings extends Context.Service<Settings, Effect.Success<typeof make>>()(
  "hydra/controller/settings/Settings",
) {}

export const SettingsLayer: Layer.Layer<Settings, never, SqlClient.SqlClient> = Layer.effect(
  Settings,
  make,
);
