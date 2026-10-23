/**
 * Tests what the session role migration does to a database at the previous
 * head: a session written before it has no role.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestDatabaseWriter } from "../testing";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 91);

const at = "2026-10-23T00:00:00.000Z";

describe("the session role migration", () => {
  it("adds the role as NULL to the sessions written before it", async () => {
    const sessions = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* sql`INSERT INTO sessions (id, permission_profile_id, instance_id, runner_id,
                                         requested_access_mode, access_mode, spec, title, status,
                                         created_at, last_activity_at)
          VALUES ('old', 'profile', 'instance', 'runner', 'auto', 'auto', '{}', 'a session',
                  'idle', ${at}, ${at})`;
        yield* runMigrations();
        return yield* sql`SELECT id, role FROM sessions`;
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(sessions).toEqual([{ id: "old", role: null }]);
  });
});
