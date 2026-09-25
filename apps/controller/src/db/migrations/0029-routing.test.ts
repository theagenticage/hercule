/**
 * Tests what the routing migration does to the runs an earlier engine wrote:
 *
 * - it keeps every step record with its rowid, so the records are still read
 *   in the order they were created;
 * - the rebuilt table accepts a skipped step record;
 * - it fills in how often each existing run followed each edge.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 29);

const at = "2026-09-01T00:00:00.000Z";

/** Runs the migrations before 0029, then `seed`, then the rest, then `read`, on a fresh database. */
const seedMigrateAndRead = <A>(
  seed: Effect.Effect<unknown, unknown, SqlClient.SqlClient>,
  read: Effect.Effect<A, unknown, SqlClient.SqlClient>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* runMigrations(BEFORE);
      yield* seed;
      yield* runMigrations();
      return yield* read;
    }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
  );

describe("the routing migration", () => {
  it("keeps each step record's rowid and accepts a skipped one", async () => {
    const rows = await seedMigrateAndRead(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO runs (id, plan, inputs, origin, status, created_at, started_at)
          VALUES ('run', '{}', '{}', '{}', 'running', ${at}, ${at})`;
        yield* Effect.forEach(
          ["zeta", "gone", "alpha", "mid"],
          (stepId) =>
            sql`INSERT INTO run_steps (run_id, step_id, iteration, status, created_at)
              VALUES ('run', ${stepId}, 1, 'pending', ${at})`,
        );
        // The gap this leaves in the rowids closes if the rebuild numbers the
        // rows again instead of copying their rowids.
        yield* sql`DELETE FROM run_steps WHERE step_id = 'gone'`;
      }),
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO run_steps (run_id, step_id, iteration, status, created_at, finished_at)
          VALUES ('run', 'alpha', 2, 'skipped', ${at}, ${at})`;
        return yield* sql<{
          readonly rowid: number;
          readonly step_id: string;
          readonly status: string;
        }>`SELECT rowid, step_id, status FROM run_steps WHERE run_id = 'run' ORDER BY rowid`;
      }),
    );

    expect(rows.map((row) => [row.rowid, row.step_id, row.status])).toEqual([
      [1, "zeta", "pending"],
      [3, "alpha", "pending"],
      [4, "mid", "pending"],
      [5, "alpha", "skipped"],
    ]);
  });

  it("counts an edge as followed once when its source completed and its target has a record", async () => {
    // Every run has the plan a -> b -> c, and has got a different distance
    // along it.
    const plan = JSON.stringify({
      name: "A chain",
      steps: [{ id: "a" }, { id: "b" }, { id: "c" }],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    });
    const runs: ReadonlyArray<{
      readonly id: string;
      readonly status: string;
      readonly steps: ReadonlyArray<readonly [string, string]>;
    }> = [
      {
        id: "finished",
        status: "completed",
        steps: [
          ["a", "completed"],
          ["b", "completed"],
          ["c", "completed"],
        ],
      },
      {
        id: "midway",
        status: "running",
        steps: [
          ["a", "completed"],
          ["b", "running"],
        ],
      },
      { id: "at the start", status: "running", steps: [["a", "running"]] },
    ];

    const counts = await seedMigrateAndRead(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const run of runs) {
          const finishedAt = run.status === "completed" ? at : null;
          yield* sql`INSERT INTO runs (id, plan, inputs, origin, status, created_at, started_at,
                                       finished_at)
            VALUES (${run.id}, ${plan}, '{}', '{}', ${run.status}, ${at}, ${at}, ${finishedAt})`;
          yield* Effect.forEach(
            run.steps,
            ([stepId, status]) =>
              sql`INSERT INTO run_steps (run_id, step_id, iteration, status, created_at)
                VALUES (${run.id}, ${stepId}, 1, ${status}, ${at})`,
          );
        }
      }),
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{
          readonly run_id: string;
          readonly edge_index: number;
          readonly count: number;
        }>`SELECT run_id, edge_index, count FROM run_edge_traversals ORDER BY run_id, edge_index`;
      }),
    );

    expect(counts.map((row) => [row.run_id, row.edge_index, row.count])).toEqual([
      ["finished", 0, 1],
      ["finished", 1, 1],
      ["midway", 0, 1],
    ]);
  });
});
