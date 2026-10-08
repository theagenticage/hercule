/**
 * Tests what the migration that stops exits from counting as activity does
 * to the sessions written before it: an exited session gets back the time of
 * its last real event.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 56);

const created = "2026-10-08T10:00:00.000Z";
const lastTurn = "2026-10-08T11:00:00.000Z";
const exit = "2026-10-08T20:40:35.000Z";
const strayEvent = "2026-10-08T20:41:00.000Z";

/** Runs a test against a fresh in-memory database. */
const runOnDatabase = <A>(test: Effect.Effect<A, unknown, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(test.pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie));

describe("the exit-is-not-activity migration", () => {
  it("sets an exited session's last activity to its last event before the exit, and leaves the rest alone", async () => {
    const sessions = await runOnDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        // Every session was stamped with the exit time, as the old code did.
        yield* sql`INSERT INTO sessions (id, permission_profile_id, instance_id, runner_id,
                                         requested_access_mode, access_mode, spec, title, status,
                                         created_at, last_activity_at, exited_at)
          VALUES ('exited', 'profile', 'instance', 'runner', 'auto', 'auto', '{}', 'a', 'exited',
                  ${created}, ${exit}, ${exit}),
                 ('never-ran', 'profile', 'instance', 'runner', 'auto', 'auto', '{}', 'b', 'exited',
                  ${created}, ${exit}, ${exit}),
                 ('idle', 'profile', 'instance', 'runner', 'auto', 'auto', '{}', 'c', 'idle',
                  ${created}, ${lastTurn}, NULL)`;
        for (const [sessionId, position, at, tag] of [
          ["exited", 1, created, "session.started"],
          ["exited", 2, lastTurn, "turn.completed"],
          ["exited", 3, exit, "session.exited"],
          ["exited", 4, strayEvent, "session.usage.updated"],
          ["never-ran", 1, exit, "session.exited"],
          ["idle", 1, lastTurn, "turn.completed"],
        ] as const) {
          yield* sql`INSERT INTO session_stream (session_id, position, runner_seq, at, event)
            VALUES (${sessionId}, ${position}, ${position}, ${at}, ${JSON.stringify({ _tag: tag })})`;
        }
        yield* runMigrations();
        return yield* sql`SELECT id, last_activity_at, exited_at FROM sessions ORDER BY id`;
      }),
    );

    expect(sessions).toEqual([
      // The exit itself and the stray event after it do not count.
      { id: "exited", last_activity_at: lastTurn, exited_at: exit },
      { id: "idle", last_activity_at: lastTurn, exited_at: null },
      { id: "never-ran", last_activity_at: exit, exited_at: exit },
    ]);
  });
});
