/**
 * Tests what the migration for runs failed by the controller does to runs an
 * earlier engine wrote: a failed run with no step, or that never started, is
 * marked `controller-error`, and every other run is left alone.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 28);

const at = "2026-09-01T00:00:00.000Z";

interface SeededRun {
  readonly name: string;
  readonly status: "running" | "failed";
  readonly failureReason: string | null;
  readonly failedStepId: string | null;
  readonly startedAt: string | null;
}

interface MigratedRun {
  readonly failureReason: string | null;
  readonly failedStepId: string | null;
}

/** Inserts the runs, runs the migration, and returns each run's failure columns after it, by name. */
const seedAndMigrate = (
  seeded: ReadonlyArray<SeededRun>,
): Promise<ReadonlyMap<string, MigratedRun>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations(BEFORE);
      yield* Effect.forEach(
        seeded,
        (run) =>
          sql`INSERT INTO runs (id, plan, inputs, origin, status, failure_reason, failed_step_id,
                                created_at, started_at, finished_at)
            VALUES (${run.name}, '{}', '{}', ${JSON.stringify({ name: run.name })}, ${run.status},
                    ${run.failureReason}, ${run.failedStepId}, ${at}, ${run.startedAt},
                    ${run.status === "failed" ? at : null})`,
      );
      yield* runMigrations();
      const rows = yield* sql<{
        readonly name: string;
        readonly failure_reason: string | null;
        readonly failed_step_id: string | null;
      }>`SELECT json_extract(origin, '$.name') AS name, failure_reason, failed_step_id FROM runs`;
      return new Map(
        rows.map((row) => [
          row.name,
          { failureReason: row.failure_reason, failedStepId: row.failed_step_id },
        ]),
      );
    }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
  );

describe("runs failed by the controller before controller-error existed", () => {
  it("marks a failed run with no failed step, or that never started, as controller-error and keeps its step", async () => {
    const runs = await seedAndMigrate([
      {
        name: "no step",
        status: "failed",
        failureReason: "step-failed",
        failedStepId: null,
        startedAt: at,
      },
      {
        name: "never started",
        status: "failed",
        failureReason: "step-failed",
        failedStepId: "create",
        startedAt: null,
      },
    ]);

    expect(runs.get("no step")).toEqual({ failureReason: "controller-error", failedStepId: null });
    expect(runs.get("never started")).toEqual({
      failureReason: "controller-error",
      failedStepId: "create",
    });
  });

  it("leaves a run that failed at a step it started, and a running run, as they are", async () => {
    const runs = await seedAndMigrate([
      {
        name: "step failed",
        status: "failed",
        failureReason: "step-failed",
        failedStepId: "create",
        startedAt: at,
      },
      {
        name: "expression error",
        status: "failed",
        failureReason: "expression-error",
        failedStepId: "update",
        startedAt: at,
      },
      {
        name: "running",
        status: "running",
        failureReason: null,
        failedStepId: null,
        startedAt: at,
      },
    ]);

    expect(runs.get("step failed")).toEqual({
      failureReason: "step-failed",
      failedStepId: "create",
    });
    expect(runs.get("expression error")).toEqual({
      failureReason: "expression-error",
      failedStepId: "update",
    });
    expect(runs.get("running")).toEqual({ failureReason: null, failedStepId: null });
  });
});
