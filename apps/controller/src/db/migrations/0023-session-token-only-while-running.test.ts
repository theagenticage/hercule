/**
 * Tests what the migration that limits a token hash to running sessions does
 * to existing rows: a running session keeps the hash its process presents, and
 * every other row loses a hash that was already unusable.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 23);

const at = "2026-09-01T00:00:00.000Z";

const STATUSES = ["queued", "starting", "idle", "busy", "exited"] as const;

/**
 * Returns the token hash of each status's row after the migration has run,
 * and the error from giving a second row a hash another row already has.
 */
const seedAndMigrate = (): Promise<{
  readonly hashes: Readonly<Record<string, string | null>>;
  readonly duplicate: string;
}> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations(BEFORE);
      yield* Effect.forEach(
        STATUSES,
        (status, index) =>
          sql`INSERT INTO sessions (id, permission_profile_id, instance_id, runner_id,
                                    requested_access_mode, access_mode, spec, title, status,
                                    created_at, last_activity_at, token_hash)
              VALUES (unhex(${`0199e0e77b217000800000000000${String(index).padStart(4, "0")}`}),
                      x'00', x'00', x'00', 'auto', 'auto', '{}', 'a session', ${status},
                      ${at}, ${at}, ${`hash-${status}`})`,
      );
      yield* runMigrations();
      const rows = yield* sql<{
        readonly status: string;
        readonly token_hash: string | null;
      }>`SELECT status, token_hash FROM sessions`;
      const duplicate = yield* Effect.flip(sql`
        UPDATE sessions SET token_hash = 'hash-busy' WHERE status = 'idle'
      `);
      return {
        hashes: Object.fromEntries(rows.map((row) => [row.status, row.token_hash])),
        duplicate: String(duplicate.cause.cause),
      };
    }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
  );

describe("a token hash in a database written before the rule", () => {
  it("stays on a running session and is dropped from every other one", async () => {
    expect((await seedAndMigrate()).hashes).toEqual({
      queued: null,
      starting: "hash-starting",
      idle: "hash-idle",
      busy: "hash-busy",
      exited: null,
    });
  });

  it("is still unique once the column is rebuilt", async () => {
    // Two sessions that share a credential would each act as the other.
    expect((await seedAndMigrate()).duplicate).toContain("UNIQUE constraint failed");
  });
});
