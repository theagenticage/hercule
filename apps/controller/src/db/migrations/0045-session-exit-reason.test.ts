/**
 * Tests what the session exit reason migration does to a database at the
 * previous head: a session written before it, exited or not, has no exit
 * reason.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 45);

const at = "2026-10-05T00:00:00.000Z";

/** Runs a test against a fresh in-memory database. */
const runOnDatabase = <A>(test: Effect.Effect<A, unknown, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(test.pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie));

describe("the session exit reason migration", () => {
  it("adds the exit reason as NULL to the sessions written before it", async () => {
    const sessions = await runOnDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* sql`INSERT INTO sessions (id, permission_profile_id, instance_id, runner_id,
                                         requested_access_mode, access_mode, spec, title, status,
                                         created_at, last_activity_at, exited_at)
          VALUES ('exited', 'profile', 'instance', 'runner', 'auto', 'auto', '{}', 'a session',
                  'exited', ${at}, ${at}, ${at}),
                 ('idle', 'profile', 'instance', 'runner', 'auto', 'auto', '{}', 'a session',
                  'idle', ${at}, ${at}, NULL)`;
        yield* runMigrations();
        return yield* sql`SELECT id, exit_reason FROM sessions ORDER BY id`;
      }),
    );

    expect(sessions).toEqual([
      { id: "exited", exit_reason: null },
      { id: "idle", exit_reason: null },
    ]);
  });
});
