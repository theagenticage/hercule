/**
 * Tests what the original run id migration does to a database at the
 * previous head: `runs` gains `original_run_id`, NULL for every run written
 * before it, because no run was a re-run then, and the partial index that
 * serves the list of a run's re-runs exists and is the one that list uses.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 35);

const at = "2026-09-01T00:00:00.000Z";

describe("the original run id migration", () => {
  it("adds original_run_id as NULL to existing runs, and a partial index over the runs that have one", async () => {
    const { runs, index, plan } = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* sql`
          INSERT INTO runs (id, plan, inputs, origin, status, created_at, started_at, finished_at)
          VALUES ('finished', '{}', '{}', '{}', 'completed', ${at}, ${at}, ${at}),
                 ('pending', '{}', '{}', '{}', 'pending', ${at}, NULL, NULL)`;
        yield* runMigrations();
        const runs = yield* sql<{
          readonly id: string;
          readonly original_run_id: Uint8Array | null;
        }>`SELECT CAST(id AS TEXT) AS id, original_run_id FROM runs ORDER BY id`;
        const index = yield* sql<{ readonly sql: string }>`
          SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'runs_original_run_id'`;
        // The query of the run list filtered to one run's re-runs, newest first.
        const plan = yield* sql<{ readonly detail: string }>`
          EXPLAIN QUERY PLAN
          SELECT * FROM runs WHERE original_run_id = ${new Uint8Array(16)}
          ORDER BY created_at DESC, id DESC`;
        return { runs, index, plan };
      }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
    );

    expect(runs).toEqual([
      { id: "finished", original_run_id: null },
      { id: "pending", original_run_id: null },
    ]);
    expect(index).toHaveLength(1);
    expect(index[0]!.sql.replace(/\s+/g, " ").trim()).toBe(
      "CREATE INDEX runs_original_run_id ON runs (original_run_id, created_at, id) WHERE original_run_id IS NOT NULL",
    );
    // The list reads the index in order, with no separate sort.
    expect(plan.map((step) => step.detail)).toEqual([
      "SEARCH runs USING INDEX runs_original_run_id (original_run_id=?)",
    ]);
  });
});
