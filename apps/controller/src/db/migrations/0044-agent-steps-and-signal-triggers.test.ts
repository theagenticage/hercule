/**
 * Tests what the agent steps and signal triggers migration does to a database
 * at the previous head: every new column is NULL on the rows written before
 * it, the session list filtered to one run reads its partial index in order,
 * and one event can start a step of a run only once.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 44);

const at = "2026-10-01T00:00:00.000Z";

/** Runs a test against a fresh in-memory database. */
const runOnDatabase = <A>(test: Effect.Effect<A, unknown, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(test.pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie));

/** Returns an index's SQL with its whitespace collapsed, or `undefined` if it does not exist. */
const readIndexSql = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly sql: string }>`
      SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ${name}`;
    return rows[0]?.sql.replace(/\s+/g, " ").trim();
  });

describe("the agent steps and signal triggers migration", () => {
  it("adds the new columns as NULL to the sessions, inputs and step records written before it", async () => {
    const { sessions, inputs, steps } = await runOnDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* sql`INSERT INTO sessions (id, permission_profile_id, instance_id, runner_id,
                                         requested_access_mode, access_mode, spec, title, status,
                                         created_at, last_activity_at)
          VALUES ('session', 'profile', 'instance', 'runner', 'auto', 'auto', '{}', 'a session',
                  'idle', ${at}, ${at})`;
        yield* sql`INSERT INTO session_inputs (id, session_id, source, actor, text, status,
                                               created_at)
          VALUES ('input', 'session', 'user', 'user', 'hello', 'queued', ${at})`;
        yield* sql`INSERT INTO runs (id, plan, inputs, origin, status, created_at)
          VALUES ('run', '{}', '{}', '{}', 'pending', ${at})`;
        yield* sql`INSERT INTO run_steps (run_id, step_id, iteration, status, created_at)
          VALUES ('run', 'review', 1, 'pending', ${at})`;
        yield* runMigrations();
        const sessions = yield* sql`SELECT run_id, step_id FROM sessions`;
        const inputs = yield* sql`SELECT step_iteration FROM session_inputs`;
        const steps = yield* sql`SELECT session_id, event_id FROM run_steps`;
        return { sessions, inputs, steps };
      }),
    );

    expect(sessions).toEqual([{ run_id: null, step_id: null }]);
    expect(inputs).toEqual([{ step_iteration: null }]);
    expect(steps).toEqual([{ session_id: null, event_id: null }]);
  });

  it("lists one run's sessions through a partial index, in the session list's order", async () => {
    const { index, plan } = await runOnDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        const index = yield* readIndexSql("sessions_run");
        // The query of the session list filtered to one run, newest first.
        const plan = yield* sql<{ readonly detail: string }>`
          EXPLAIN QUERY PLAN
          SELECT * FROM sessions WHERE run_id = ${new Uint8Array(16)}
          ORDER BY created_at DESC, id DESC`;
        return { index, plan };
      }),
    );

    expect(index).toBe(
      "CREATE INDEX sessions_run ON sessions (run_id, created_at, id) WHERE run_id IS NOT NULL",
    );
    // The list reads the index in order, with no separate sort.
    expect(plan.map((step) => step.detail)).toEqual([
      "SEARCH sessions USING INDEX sessions_run (run_id=?)",
    ]);
  });

  it("refuses a second step record of the same step for the same event, and allows any number with no event", async () => {
    const { index, again, otherStep, withoutEvent } = await runOnDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* sql`INSERT INTO runs (id, plan, inputs, origin, status, created_at)
          VALUES ('run', '{}', '{}', '{}', 'running', ${at})`;
        const insert = (stepId: string, iteration: number, eventId: number | null) =>
          Effect.exit(sql`
            INSERT INTO run_steps (run_id, step_id, iteration, status, created_at, event_id)
            VALUES ('run', ${stepId}, ${iteration}, 'pending', ${at}, ${eventId})`);
        yield* insert("review", 1, 7);
        const again = yield* insert("review", 2, 7);
        const otherStep = yield* insert("deploy", 1, 7);
        yield* insert("review", 3, null);
        const withoutEvent = yield* insert("review", 4, null);
        const index = yield* readIndexSql("run_steps_signal_event");
        return { index, again, otherStep, withoutEvent };
      }),
    );

    expect(index).toBe(
      "CREATE UNIQUE INDEX run_steps_signal_event ON run_steps (run_id, step_id, event_id) WHERE event_id IS NOT NULL",
    );
    expect(Exit.isFailure(again)).toBe(true);
    expect(Exit.isSuccess(otherStep)).toBe(true);
    expect(Exit.isSuccess(withoutEvent)).toBe(true);
  });
});
