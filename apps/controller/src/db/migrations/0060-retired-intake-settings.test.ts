/**
 * Tests what the retired-intake-settings migration does to a user's settings:
 * `topics.order` and `lastChecked.intake` are deleted, and every other key
 * stays as it was.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 60);

const at = "2026-10-01T00:00:00.000Z";

const USER = "0199a000000070008000000000000001";

/** Stores the settings, runs the migration, and returns the keys left, sorted. */
const seedAndMigrate = (
  settings: Readonly<Record<string, string>>,
): Promise<ReadonlyArray<string>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations(BEFORE);
      yield* sql`INSERT INTO users (id, username, password_hash, created_at, updated_at)
        VALUES (unhex(${USER}), 'ada', 'hash', ${at}, ${at})`;
      for (const [key, value] of Object.entries(settings)) {
        yield* sql`INSERT INTO user_settings (user_id, key, value, updated_at)
          VALUES (unhex(${USER}), ${key}, ${value}, ${at})`;
      }
      yield* runMigrations();
      const rows = yield* sql<{ readonly key: string }>`
        SELECT key FROM user_settings ORDER BY key`;
      return rows.map((row) => row.key);
    }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
  );

describe("the retired Intake settings", () => {
  it("are deleted, and every other user setting stays", async () => {
    const keys = await seedAndMigrate({
      timezone: '"Europe/Amsterdam"',
      "topics.order": '["intake","checkin"]',
      "lastChecked.intake": '"2026-09-30T08:00:00.000Z"',
      "lastChecked.notifications": '"2026-09-30T08:00:00.000Z"',
    });

    expect(keys).toEqual(["lastChecked.notifications", "timezone"]);
  });
});
