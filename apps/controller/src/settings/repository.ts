/**
 * Reads and writes settings, which are stored in two tables, one per scope:
 *
 * - `settings` holds the controller's operational settings, edited in
 *   Settings > System and seeded at first run.
 * - `user_settings` holds the user settings, keyed by user id from the start,
 *   so supporting a second user needs a `WHERE` clause rather than a new table.
 *
 * The keys and their value schemas are declared once, in the contract
 * (`SETTING_VALUES`). The same map defines the `settings.read` response and
 * the JSON in the `value` column, so a key cannot mean one thing to a caller
 * and another in the database. Values are stored as JSON text and decoded with
 * the key's Effect Schema, so a stored value that does not match the schema is
 * an error rather than a value the caller misreads.
 */
import { Context, Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { Id, SETTING_VALUES } from "@hercule/contract";
import { nowIso, uuidFromString } from "../db";

/** The keys each scope defines, with the schema of the value. */
const SETTING_SCHEMAS = SETTING_VALUES;

/** A scope whose keys are declared, so every read and write of it is typed. */
export type TypedScope = keyof typeof SETTING_SCHEMAS;

export type SettingKey<S extends TypedScope> = keyof (typeof SETTING_SCHEMAS)[S] & string;

export type SettingValue<S extends TypedScope, K extends SettingKey<S>> = Schema.Schema.Type<
  (typeof SETTING_SCHEMAS)[S][K]
>;

/** The settings of one scope. A key that is not set is absent. */
export type ScopeSettings<S extends TypedScope> = {
  readonly [K in SettingKey<S>]?: SettingValue<S, K>;
};

/** Fails a read when a setting is not set, or holds a value its schema rejects. */
export class SettingError extends Schema.TaggedError<SettingError>()("SettingError", {
  scope: Schema.String,
  key: Schema.String,
  message: Schema.String,
}) {}

/**
 * The key of the default runner: the runner a placement uses when nothing else
 * chooses one.
 *
 * It is stored in the controller's settings table because there is no other
 * controller table to add it to, but the settings API does not expose it:
 *
 * - `controller.update` is the only operation that takes the id from a caller,
 *   so it checks that the id refers to a runner that can take sessions.
 * - `controller.read` returns it.
 * - `runners/` also writes it, when the first runner joins and when the
 *   default runner is retired, but never with a value from a caller.
 *
 * `all` below excludes the key by name rather than letting `decodeRows` skip
 * it as undeclared, because `decodeRows` logs a warning for such keys, and
 * this key is excluded on purpose, not left over from a downgrade.
 */
const DEFAULT_RUNNER_ID = "defaultRunnerId";

const DefaultRunnerId = Schema.fromJsonString(Schema.NullOr(Id));

const createSettingError = (message: string): SettingError =>
  new SettingError({ scope: "controller", key: DEFAULT_RUNNER_ID, message });

/**
 * Builds the codec for one key: its declared schema, wrapped to convert from
 * and to the JSON text in the `value` column. The lookup takes a plain string,
 * so only the caller's typed key keeps the value type correct.
 */
const buildStoredCodec = (scope: TypedScope, key: string): Schema.Codec<unknown, string> =>
  Schema.fromJsonString((SETTING_SCHEMAS[scope] as Record<string, Schema.Codec<unknown>>)[key]!);

/** Decodes one stored value to the key's declared type. Fails with `SettingError` if it does not match. */
const decode = (
  scope: TypedScope,
  key: string,
  value: string,
): Effect.Effect<unknown, SettingError> =>
  Schema.decodeUnknownEffect(buildStoredCodec(scope, key))(value).pipe(
    Effect.mapError((error) => new SettingError({ scope, key, message: error.message })),
  );

/** Encodes one value as JSON text for the `value` column. Fails with `SettingError` if it does not match. */
const encode = (
  scope: TypedScope,
  key: string,
  value: unknown,
): Effect.Effect<string, SettingError> =>
  Schema.encodeUnknownEffect(buildStoredCodec(scope, key))(value).pipe(
    Effect.mapError((error) => new SettingError({ scope, key, message: error.message })),
  );

/**
 * Decodes every row of one scope to its key's declared type.
 *
 * A row this version cannot read is skipped with a warning in the log, rather
 * than failing the whole read over one key the caller never asked about. A row
 * cannot be read in two cases:
 *
 * - its key is not declared, which is what a downgrade leaves behind;
 * - its value no longer matches the key's schema, which is what narrowing a
 *   key's type leaves behind (`thread.workspace` lost `none` in
 *   [#72](https://github.com/theagenticage/hercule/issues/72)).
 *
 * Both rows read as unset, which is what the setting meant anyway, so neither
 * case needs a migration.
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
      const value = yield* Effect.option(decode(scope, row.key, row.value));
      if (Option.isNone(value)) {
        yield* Effect.logWarning(
          `Ignoring the ${scope} setting ${row.key}: its stored value is invalid for this version.`,
        );
        continue;
      }
      entries.push([row.key, value.value] as const);
    }
    // Every key belongs to the scope and every value was decoded with that
    // key's schema, which is what the mapped type requires. TypeScript cannot
    // infer that through the loop, so the cast is needed.
    return Object.fromEntries(entries) as ScopeSettings<S>;
  });

/** The columns both tables return when their rows are listed. */
interface KeyValueRow {
  readonly key: string;
  readonly value: string;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /** Reads one controller setting, decoded to the key's type. Fails if it is not set or invalid. */
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
     * Returns every controller setting that is set, decoded to its declared
     * type. A key nobody has set is absent rather than defaulted, so the
     * default lives in one place: the code that reads the key.
     */
    all: (): Effect.Effect<ScopeSettings<"controller">, SettingError | SqlError> =>
      Effect.flatMap(
        sql<KeyValueRow>`
          SELECT key, value FROM settings
          WHERE scope = 'controller' AND key <> ${DEFAULT_RUNNER_ID} ORDER BY key
        `,
        (rows) => decodeRows("controller", rows),
      ),

    /** Returns the id of the default runner, or null if none is chosen. */
    defaultRunnerId: (): Effect.Effect<string | null, SettingError | SqlError> =>
      Effect.flatMap(
        sql<KeyValueRow>`
          SELECT key, value FROM settings
          WHERE scope = 'controller' AND key = ${DEFAULT_RUNNER_ID}
        `,
        (rows) => {
          const row = rows[0];
          if (row === undefined) return Effect.succeed(null);
          return Schema.decodeUnknownEffect(DefaultRunnerId)(row.value).pipe(
            Effect.mapError((error) => createSettingError(error.message)),
          );
        },
      ),

    /** Sets the default runner, or clears it when `id` is null. */
    setDefaultRunnerId: (
      id: string | null,
      at: string,
    ): Effect.Effect<void, SettingError | SqlError> =>
      Effect.gen(function* () {
        const json = yield* Effect.mapError(
          Schema.encodeUnknownEffect(DefaultRunnerId)(id),
          (error) => createSettingError(error.message),
        );
        yield* sql`
          INSERT INTO settings (scope, key, value, updated_at)
          VALUES ('controller', ${DEFAULT_RUNNER_ID}, ${json}, ${at})
          ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `;
      }),

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

    /** Reads one of a user's settings, decoded to the key's type. Fails if it is not set or invalid. */
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

    /** Returns every setting one user has set, decoded to its declared type. */
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
  "hercule/controller/settings/Settings",
) {}

export const SettingsLayer: Layer.Layer<Settings, never, SqlClient.SqlClient> = Layer.effect(
  Settings,
  make,
);
