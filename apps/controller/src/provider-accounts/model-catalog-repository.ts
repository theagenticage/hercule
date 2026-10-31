/**
 * The Model Catalog rows: what each Provider Account's catalog source last
 * listed, when it was read, and why the last read failed.
 *
 * A row exists once a read of the account has ended, so an account that was
 * never read has none. Every reader here still returns one entry per account,
 * with no models and no read time, so a caller never has to tell "no row" from
 * "empty catalog".
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { ModelDescriptor } from "@hercule/protocol";
import { uuidFromString, uuidToString } from "../db";

/** One account's catalog as stored. `firstSeen` maps a model slug to the time the model first appeared. */
export interface StoredModelCatalog {
  readonly providerAccountId: string;
  readonly models: ReadonlyArray<ModelDescriptor>;
  /**
   * The time each slug the account's catalog has ever held first appeared.
   * Slugs are never removed. A map, because a slug such as `constructor` or
   * `__proto__` would collide with the properties of a plain object.
   */
  readonly firstSeen: ReadonlyMap<string, string>;
  /** When the last successful read ended; `null` before the first one. */
  readonly readAt: string | null;
  /**
   * When the first successful read ended; `null` before it. It is set once
   * and never changes. It is stored apart from `firstSeen` because a first
   * read that lists no model leaves `firstSeen` empty, and the first read that
   * lists some would then look like the first one.
   */
  readonly firstReadAt: string | null;
  /** Why the newest read failed; `null` when it succeeded or none has run. */
  readonly error: string | null;
  /** When the controller sent the probe whose answer `models` holds; `null` before the first successful read. */
  readonly modelsStamp: string | null;
  /** When the controller sent the newest probe that ended in a read, successful or not; `null` before any. */
  readonly attemptStamp: string | null;
}

/** What a listing of accounts needs from a catalog: its size and how the last read went. */
export interface StoredModelCatalogSummary {
  readonly providerAccountId: string;
  readonly modelCount: number;
  readonly readAt: string | null;
  readonly error: string | null;
}

interface CatalogRow {
  readonly provider_account_id: Uint8Array;
  readonly models: string | null;
  readonly first_seen: string | null;
  readonly read_at: string | null;
  readonly first_read_at: string | null;
  readonly error: string | null;
  readonly models_stamp: string | null;
  readonly attempt_stamp: string | null;
}

const decodeModels = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(ModelDescriptor)),
);

const decodeFirstSeen = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);

const toStoredCatalog = (row: CatalogRow): Effect.Effect<StoredModelCatalog, Schema.SchemaError> =>
  Effect.gen(function* () {
    return {
      providerAccountId: uuidToString(row.provider_account_id),
      models: row.models === null ? [] : yield* decodeModels(row.models),
      firstSeen: new Map(
        Object.entries(row.first_seen === null ? {} : yield* decodeFirstSeen(row.first_seen)),
      ),
      readAt: row.read_at,
      firstReadAt: row.first_read_at,
      error: row.error,
      modelsStamp: row.models_stamp,
      attemptStamp: row.attempt_stamp,
    };
  });

/** Selects one entry per account, with the catalog columns empty for an account that was never read. */
const SELECT_CATALOGS = `
  SELECT a.id AS provider_account_id, c.models, c.first_seen, c.read_at, c.first_read_at, c.error,
         c.models_stamp, c.attempt_stamp
  FROM provider_accounts a
  LEFT JOIN model_catalogs c ON c.provider_account_id = a.id
`;

/**
 * Returns the time to record for a slug that appears in a read that ended at
 * `readAt`: `readAt`, but never at or before the account's first read
 * (`firstReadAt`, `null` while there is none). A clock that stepped backwards
 * could otherwise date a later arrival before the first read, and then the
 * model would never be announced as new.
 */
const pickArrivalTime = (firstReadAt: string | null, readAt: string): string => {
  if (firstReadAt === null) return readAt;
  const earliest = Date.parse(firstReadAt) + 1;
  return Date.parse(readAt) >= earliest ? readAt : new Date(earliest).toISOString();
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /**
   * Returns the account's catalog, or `none` when the account does not exist.
   * An account that was never read has an empty catalog.
   */
  const readOne = (
    providerAccountId: string,
  ): Effect.Effect<Option.Option<StoredModelCatalog>, SqlError | Schema.SchemaError> =>
    Effect.flatMap(
      sql<CatalogRow>`
        ${sql.literal(SELECT_CATALOGS)} WHERE a.id = ${uuidFromString(providerAccountId)}
      `,
      (rows) =>
        rows[0] === undefined
          ? Effect.succeed(Option.none())
          : Effect.map(toStoredCatalog(rows[0]), Option.some),
    );

  /** Writes the row of an account that has a catalog already or gets its first one now. */
  const upsert = (catalog: StoredModelCatalog): Effect.Effect<void, SqlError> =>
    Effect.asVoid(sql`
      INSERT INTO model_catalogs
        (provider_account_id, models, first_seen, read_at, first_read_at, error, models_stamp,
         attempt_stamp)
      VALUES (${uuidFromString(catalog.providerAccountId)}, ${JSON.stringify(catalog.models)},
              ${JSON.stringify(Object.fromEntries(catalog.firstSeen))}, ${catalog.readAt},
              ${catalog.firstReadAt}, ${catalog.error}, ${catalog.modelsStamp},
              ${catalog.attemptStamp})
      ON CONFLICT (provider_account_id) DO UPDATE SET
        models = excluded.models,
        first_seen = excluded.first_seen,
        read_at = excluded.read_at,
        first_read_at = excluded.first_read_at,
        error = excluded.error,
        models_stamp = excluded.models_stamp,
        attempt_stamp = excluded.attempt_stamp
    `);

  /** Returns whether `stamp` is later than `than`, which is `null` when nothing was stored yet. */
  const isLater = (stamp: string, than: string | null): boolean =>
    than === null || Date.parse(than) < Date.parse(stamp);

  return {
    /** Returns the catalog of every account, in the order the accounts were added. */
    listCatalogs: (): Effect.Effect<
      ReadonlyArray<StoredModelCatalog>,
      SqlError | Schema.SchemaError
    > =>
      Effect.flatMap(
        sql<CatalogRow>`${sql.literal(SELECT_CATALOGS)} ORDER BY a.created_at, a.id`,
        (rows) => Effect.forEach(rows, toStoredCatalog),
      ),

    /**
     * Returns the size and read state of every account's catalog without
     * reading its models, so listing accounts does not decode every model.
     */
    listSummaries: (): Effect.Effect<ReadonlyArray<StoredModelCatalogSummary>, SqlError> =>
      Effect.map(
        sql<{
          readonly provider_account_id: Uint8Array;
          readonly model_count: number | null;
          readonly read_at: string | null;
          readonly error: string | null;
        }>`
          SELECT a.id AS provider_account_id, json_array_length(c.models) AS model_count,
                 c.read_at, c.error
          FROM provider_accounts a
          LEFT JOIN model_catalogs c ON c.provider_account_id = a.id
        `,
        (rows) =>
          rows.map((row) => ({
            providerAccountId: uuidToString(row.provider_account_id),
            modelCount: row.model_count ?? 0,
            readAt: row.read_at,
            error: row.error,
          })),
      ),

    readOne,

    /**
     * Stores a successful read: replaces the models, sets `readAt`, and adds
     * the slugs the catalog has not held before to `firstSeen` at `readAt`.
     * The first successful read also sets `firstReadAt` to `readAt`. A slug
     * first seen in a later read is dated at `readAt`, or one millisecond
     * after `firstReadAt` if `readAt` is not later than that.
     * `stamp` is when the controller sent the probe.
     *
     * Returns whether it stored: `false` when the catalog already holds models
     * from a probe sent at or after `stamp`, or the account does not exist.
     *
     * The error is cleared only when no later-sent read has ended since. A
     * failure sent after this probe stays the newest word on the error, but
     * these models are still newer than the stored ones.
     */
    recordSuccess: (
      providerAccountId: string,
      models: ReadonlyArray<ModelDescriptor>,
      readAt: string,
      stamp: string,
    ): Effect.Effect<boolean, SqlError | Schema.SchemaError> =>
      Effect.gen(function* () {
        const found = yield* readOne(providerAccountId);
        if (Option.isNone(found) || !isLater(stamp, found.value.modelsStamp)) return false;
        const firstSeen = new Map(found.value.firstSeen);
        const arrivedAt = pickArrivalTime(found.value.firstReadAt, readAt);
        for (const model of models) {
          if (!firstSeen.has(model.slug)) firstSeen.set(model.slug, arrivedAt);
        }
        const newestIsLater =
          found.value.attemptStamp !== null && isLater(found.value.attemptStamp, stamp);
        yield* upsert({
          providerAccountId,
          models,
          firstSeen,
          readAt,
          firstReadAt: found.value.firstReadAt ?? readAt,
          error: newestIsLater ? found.value.error : null,
          modelsStamp: stamp,
          attemptStamp: newestIsLater ? found.value.attemptStamp : stamp,
        });
        return true;
      }),

    /**
     * Stores a failed read: keeps the models and the time of the last good
     * read, and sets the error. Returns whether it stored: `false` when a read
     * sent at or after `stamp` has ended already, or the account does not
     * exist.
     */
    recordFailure: (
      providerAccountId: string,
      error: string,
      stamp: string,
    ): Effect.Effect<boolean, SqlError | Schema.SchemaError> =>
      Effect.gen(function* () {
        const found = yield* readOne(providerAccountId);
        if (Option.isNone(found) || !isLater(stamp, found.value.attemptStamp)) return false;
        yield* upsert({ ...found.value, error, attemptStamp: stamp });
        return true;
      }),
  };
});

export const modelCatalogRepository = make;
