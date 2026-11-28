/**
 * Tests what the Model Catalogs and Profiles migration does to a database at
 * the previous head: it adds the two tables and one profile, "Main", that
 * holds every existing Provider Account in the order the accounts were added,
 * with every selection still pending.
 *
 * The tests stop at this migration, so a later migration cannot change what
 * they check.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { uuidToString } from "../id";
import { runMigrations } from "../migrate";
import { TestDatabaseWriter } from "../testing";
import { migrations } from "./index";

const BEFORE = migrations.filter(([id]) => id < 100);
const UP_TO_MODEL_PROFILES = migrations.filter(([id]) => id <= 100);

/** The id of an account a test writes, as the bytes a table stores. */
const bytes = (fill: number): Uint8Array => new Uint8Array(16).fill(fill);

const minute = (n: number): string => `2026-10-01T00:${String(n).padStart(2, "0")}:00.000Z`;

/** Inserts accounts one minute apart, in the order given, so creation order differs from id order. */
const insertAccounts = (fills: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.forEach(
      fills,
      (fill, index) =>
        sql`INSERT INTO provider_accounts
              (id, provider_id, kind, label, default_harness_id, created_at, updated_at)
            VALUES (${bytes(fill)}, 'anthropic/anthropic', 'api-key', ${`account ${fill}`},
                    'claude-code/claude-code', ${minute(index)}, ${minute(index)})`,
      { discard: true },
    );
  });

const migrateAndReadProfiles = (fills: ReadonlyArray<number>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations(BEFORE);
      yield* insertAccounts(fills);
      yield* runMigrations(UP_TO_MODEL_PROFILES);
      return yield* sql<{
        readonly id: Uint8Array;
        readonly name: string;
        readonly revision: number;
        readonly body: string;
      }>`SELECT id, name, revision, body FROM model_profiles`;
    }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
  );

describe("the model catalogs and profiles migration", () => {
  it("creates the profile Main with every account in the order they were added, and every selection pending", async () => {
    // Added in the order 0x30, 0x10, 0x20: not the order of their ids.
    const profiles = await migrateAndReadProfiles([0x30, 0x10, 0x20]);

    expect(profiles).toHaveLength(1);
    const [main] = profiles;
    expect(main).toMatchObject({ name: "Main", revision: 1 });
    expect(main!.id).toHaveLength(16);
    expect(JSON.parse(main!.body)).toEqual({
      accounts: [0x30, 0x10, 0x20].map((fill) => ({
        providerAccountId: uuidToString(bytes(fill)),
        harnessId: null,
        entries: null,
      })),
      defaultEntry: null,
      dismissedNewModels: [],
    });
  });

  it("creates Main even when there is no account", async () => {
    const profiles = await migrateAndReadProfiles([]);

    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ name: "Main", revision: 1 });
    expect(JSON.parse(profiles[0]!.body)).toEqual({
      accounts: [],
      defaultEntry: null,
      dismissedNewModels: [],
    });
  });

  it("deletes an account's catalog with the account", async () => {
    const remaining = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* insertAccounts([0x10]);
        yield* runMigrations(UP_TO_MODEL_PROFILES);
        yield* sql`INSERT INTO model_catalogs (provider_account_id, models, first_seen, attempt_stamp)
                   VALUES (${bytes(0x10)}, '[]', '{}', ${minute(5)})`;
        yield* sql`DELETE FROM provider_accounts WHERE id = ${bytes(0x10)}`;
        return yield* sql`SELECT 1 FROM model_catalogs`;
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(remaining).toHaveLength(0);
  });
});
