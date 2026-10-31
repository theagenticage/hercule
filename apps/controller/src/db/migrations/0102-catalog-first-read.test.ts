/**
 * Tests what the catalog first read migration does to a database at the
 * previous head: a catalog that was read gets the time of its first read from
 * its first-seen ledger, else from its last read, and a catalog that never
 * succeeded stays empty.
 *
 * The tests stop at this migration, so a later migration cannot change what
 * they check.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../migrate";
import { TestDatabaseWriter } from "../testing";
import { migrations } from "./index";

const BEFORE = migrations.filter(([id]) => id < 102);
const UP_TO_CATALOG_FIRST_READ = migrations.filter(([id]) => id <= 102);

const FIRST_READ = "2026-10-01T08:00:00.000Z";
const SECOND_READ = "2026-10-01T12:00:00.000Z";
const LAST_READ = "2026-10-02T12:00:00.000Z";

/** The id of an account a test writes, as the bytes a table stores. */
const bytes = (fill: number): Uint8Array => new Uint8Array(16).fill(fill);

/**
 * Writes an account and its catalog row as the previous head stores them.
 * `firstSeen` is the ledger, `readAt` is `null` for a catalog that never
 * succeeded.
 */
const insertCatalog = (
  fill: number,
  firstSeen: Readonly<Record<string, string>>,
  readAt: string | null,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO provider_accounts
                 (id, provider_id, kind, label, default_harness_id, created_at, updated_at)
               VALUES (${bytes(fill)}, 'anthropic/anthropic', 'api-key', ${`account ${fill}`},
                       'claude-code/claude-code', ${FIRST_READ}, ${FIRST_READ})`;
    yield* sql`INSERT INTO model_catalogs
                 (provider_account_id, models, first_seen, read_at, error, models_stamp, attempt_stamp)
               VALUES (${bytes(fill)}, '[]', ${JSON.stringify(firstSeen)}, ${readAt}, NULL,
                       ${readAt}, ${readAt ?? FIRST_READ})`;
  });

describe("the catalog first read migration", () => {
  it("gives a read catalog the earliest time of its ledger, which is its first read", async () => {
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        // The first read listed a and b. A model that came later does not move the first read.
        yield* insertCatalog(1, { b: FIRST_READ, c: SECOND_READ, a: FIRST_READ }, LAST_READ);
        yield* runMigrations(UP_TO_CATALOG_FIRST_READ);
        return yield* sql<{ readonly first_read_at: string | null; readonly read_at: string }>`
          SELECT first_read_at, read_at FROM model_catalogs
        `;
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(rows).toEqual([{ first_read_at: FIRST_READ, read_at: LAST_READ }]);
  });

  it("gives a catalog with an empty ledger the time of its last read", async () => {
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* insertCatalog(1, {}, LAST_READ);
        yield* runMigrations(UP_TO_CATALOG_FIRST_READ);
        return yield* sql<{ readonly first_read_at: string | null }>`
          SELECT first_read_at FROM model_catalogs
        `;
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(rows).toEqual([{ first_read_at: LAST_READ }]);
  });

  it("leaves a catalog that never had a successful read without a first read", async () => {
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* insertCatalog(1, {}, null);
        yield* runMigrations(UP_TO_CATALOG_FIRST_READ);
        return yield* sql<{ readonly first_read_at: string | null }>`
          SELECT first_read_at FROM model_catalogs
        `;
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(rows).toEqual([{ first_read_at: null }]);
  });
});
