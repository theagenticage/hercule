/**
 * Tests what the migration for stranded runs does: a running run whose step
 * records have all ended is completed at the time its last record finished,
 * and every other run is left as it was.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 30);

const started = "2026-09-01T00:00:00.000Z";
const firstEnded = "2026-09-01T00:00:01.000Z";
const lastEnded = "2026-09-01T00:00:02.000Z";

/** A run to seed: its name, its status, and the status and finish time of each of its step records. */
interface SeededRun {
  readonly name: string;
  readonly status: "running" | "completed";
  readonly records: ReadonlyArray<{
    readonly status: "pending" | "running" | "completed" | "skipped";
    readonly finishedAt: string | null;
  }>;
}

/** Inserts the runs, runs the migration, and returns each run's status and finish time after it, by name. */
const seedAndMigrate = (
  seeded: ReadonlyArray<SeededRun>,
): Promise<ReadonlyMap<string, { readonly status: string; readonly finishedAt: string | null }>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations(BEFORE);
      yield* Effect.forEach(seeded, (run) =>
        Effect.andThen(
          sql`INSERT INTO runs (id, plan, inputs, origin, status, created_at, started_at, finished_at)
            VALUES (${run.name}, '{}', '{}', '{}', ${run.status}, ${started}, ${started},
                    ${run.status === "completed" ? started : null})`,
          Effect.forEach(
            run.records,
            (record, index) =>
              sql`INSERT INTO run_steps (run_id, step_id, iteration, status, created_at,
                                         started_at, finished_at)
                VALUES (${run.name}, ${`step-${String(index)}`}, 1, ${record.status}, ${started},
                        ${record.status === "skipped" || record.status === "pending" ? null : started},
                        ${record.finishedAt})`,
          ),
        ),
      );
      yield* runMigrations();
      const rows = yield* sql<{
        readonly id: string;
        readonly status: string;
        readonly finished_at: string | null;
      }>`SELECT CAST(id AS TEXT) AS id, status, finished_at FROM runs`;
      return new Map(
        rows.map((row) => [row.id, { status: row.status, finishedAt: row.finished_at }]),
      );
    }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
  );

describe("the migration for stranded runs", () => {
  it("completes a running run whose records have all ended, at the time the last one finished", async () => {
    const runs = await seedAndMigrate([
      {
        name: "stranded",
        status: "running",
        records: [
          { status: "completed", finishedAt: lastEnded },
          { status: "completed", finishedAt: firstEnded },
          { status: "skipped", finishedAt: firstEnded },
        ],
      },
    ]);

    expect(runs.get("stranded")).toEqual({ status: "completed", finishedAt: lastEnded });
  });

  it("leaves a run with an active record, a run with no record, and an ended run as they are", async () => {
    const runs = await seedAndMigrate([
      {
        name: "pending record",
        status: "running",
        records: [
          { status: "completed", finishedAt: firstEnded },
          { status: "pending", finishedAt: null },
        ],
      },
      {
        name: "running record",
        status: "running",
        records: [{ status: "running", finishedAt: null }],
      },
      { name: "no record", status: "running", records: [] },
      {
        name: "completed",
        status: "completed",
        records: [{ status: "completed", finishedAt: firstEnded }],
      },
    ]);

    expect(runs.get("pending record")).toEqual({ status: "running", finishedAt: null });
    expect(runs.get("running record")).toEqual({ status: "running", finishedAt: null });
    expect(runs.get("no record")).toEqual({ status: "running", finishedAt: null });
    expect(runs.get("completed")).toEqual({ status: "completed", finishedAt: started });
  });
});
