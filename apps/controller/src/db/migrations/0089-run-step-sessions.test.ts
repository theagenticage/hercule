/**
 * Tests what the run step sessions migration does to a database at the
 * previous head: the step records written before it are indexed too, only the
 * records that have a session, and the statement that reads a run's last
 * session probes the index with no sort.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestDatabaseWriter } from "../testing";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 89);

const at = "2026-10-20T00:00:00.000Z";

describe("the run step sessions migration", () => {
  it("indexes the step records written before it that have a session, and the last-session read uses the index", async () => {
    const { indexSql, entries, plan } = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* sql`
          INSERT INTO runs (id, plan, inputs, origin, status, created_at)
          VALUES (x'01', '{}', '{}', '{}', 'pending', ${at})`;
        yield* sql`
          INSERT INTO run_steps (run_id, step_id, iteration, status, session_id, created_at, started_at)
          VALUES (x'01', 'agent', 1, 'running', x'0a', ${at}, ${at}),
                 (x'01', 'agent', 2, 'running', x'0b', ${at}, '2026-10-20T00:01:00.000Z')`;
        yield* sql`
          INSERT INTO run_steps (run_id, step_id, iteration, status, created_at)
          VALUES (x'01', 'action', 1, 'pending', ${at})`;
        yield* runMigrations();
        const indexes = yield* sql<{ readonly sql: string }>`
          SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'run_steps_session'`;
        const entries = yield* sql<{ readonly session: string }>`
          SELECT hex(session_id) AS session FROM run_steps INDEXED BY run_steps_session
          WHERE run_id = x'01' AND session_id IS NOT NULL ORDER BY started_at`;
        const plan = yield* sql<{ readonly detail: string }>`
          EXPLAIN QUERY PLAN
          SELECT (SELECT s.session_id FROM run_steps s
                  WHERE s.run_id = runs.id AND s.session_id IS NOT NULL
                  ORDER BY s.started_at DESC LIMIT 1)
          FROM runs WHERE runs.id = x'01'`;
        return {
          indexSql: indexes.map((index) => index.sql.replace(/\s+/g, " ").trim()),
          entries: entries.map((entry) => entry.session),
          plan: plan.map((step) => step.detail),
        };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(indexSql).toEqual([
      "CREATE INDEX run_steps_session ON run_steps (run_id, started_at, session_id) WHERE session_id IS NOT NULL",
    ]);
    expect(entries).toEqual(["0A", "0B"]);
    expect(plan).toContain("SEARCH s USING COVERING INDEX run_steps_session (run_id=?)");
    expect(plan.some((step) => step.includes("TEMP B-TREE"))).toBe(false);
  });
});
