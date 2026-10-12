/**
 * Tests what the spawn bounds migration does to a database at the previous
 * head:
 *
 * - a trigger effect spawned before the migration keeps its run and takes
 *   its `matched_at` as `spawned_at`; a pending one stays pending, without a
 *   `spawned_at`;
 * - the table accepts the new state `held`, and a spawned effect without a
 *   `spawned_at` is refused;
 * - a trigger paused before the migration was paused manually, an active
 *   one has no `paused_by`, and `paused_by` is refused on an active trigger;
 * - a start trigger takes the spawn bound its stored definition sets,
 *   clamped to the limits a save enforces, a trigger whose definition sets
 *   none has none, and a bound with only one of its two numbers is refused;
 * - no trigger has been resumed, so `held_at_resume` is empty;
 * - every stored workflow is valid, so its `invalid_since` is empty.
 *
 * The rows are written in plain SQL. The tests stop at this migration, so a
 * later migration cannot change what they check.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 74);

/** The migrations up to and including the one under test. */
const UP_TO_SPAWN_BOUNDS = migrations.filter(([id]) => id <= 74);

const MATCHED_AT = "2026-10-01T09:00:00.000Z";
const SAVED_AT = "2026-10-01T08:00:00.000Z";

/** The id of the one workflow the test stores. Any 16 bytes will do. */
const WORKFLOW_ID = new Uint8Array(16).fill(1);
const RUN_ID = new Uint8Array(16).fill(2);

/**
 * The stored definition: the trigger `active` sets a spawn bound, `legacy`
 * sets one over today's limits, and `paused` sets none.
 */
const DEFINITION = JSON.stringify({
  name: "w",
  triggers: [
    { id: "active", on: { kind: "task.created" }, spawnBound: { maxRuns: 5, windowSeconds: 600 } },
    {
      id: "legacy",
      on: { kind: "task.created" },
      spawnBound: { maxRuns: 20_000, windowSeconds: Number.MAX_SAFE_INTEGER },
    },
    { id: "paused", on: { kind: "task.created" } },
  ],
  steps: [],
});

/**
 * Runs a statement and returns `accepted`, or SQLite's error message when a
 * constraint refuses it.
 */
const attemptStatement = <A>(statement: Effect.Effect<A, SqlError>) =>
  Effect.match(statement, {
    // The SQL error wraps a constraint error, which wraps SQLite's own
    // error, and only SQLite's message names the constraint.
    onFailure: (error) => String(error.cause.cause),
    onSuccess: () => "accepted",
  });

describe("the spawn bounds migration", () => {
  it("backfills spawned_at, paused_by and the spawn bounds, leaves the rest empty, and enforces the new checks", async () => {
    const checked = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* sql`
          INSERT INTO workflows (id, source, definition, enabled, created_at, updated_at)
          VALUES (${WORKFLOW_ID}, 'name: w', ${DEFINITION}, 1, ${SAVED_AT}, ${SAVED_AT})`;
        yield* sql`
          INSERT INTO triggers (workflow_id, trigger_id, kind, event_kind, status, created_at, updated_at)
          VALUES (${WORKFLOW_ID}, 'active', 'start', 'task.created', 'active', ${SAVED_AT}, ${SAVED_AT}),
                 (${WORKFLOW_ID}, 'legacy', 'start', 'task.created', 'active', ${SAVED_AT}, ${SAVED_AT}),
                 (${WORKFLOW_ID}, 'paused', 'start', 'task.created', 'paused', ${SAVED_AT}, ${SAVED_AT})`;
        yield* sql`
          INSERT INTO trigger_effects (workflow_id, trigger_id, event_id, state, inputs, run_id, matched_at)
          VALUES (${WORKFLOW_ID}, 'active', 1, 'spawned', '{}', ${RUN_ID}, ${MATCHED_AT}),
                 (${WORKFLOW_ID}, 'active', 2, 'pending', '{}', NULL, ${MATCHED_AT})`;
        yield* runMigrations(UP_TO_SPAWN_BOUNDS);

        const effects = yield* sql<{
          readonly event_id: number;
          readonly state: string;
          readonly has_run: number;
          readonly spawned_at: string | null;
        }>`
          SELECT event_id, state, run_id IS NOT NULL AS has_run, spawned_at
          FROM trigger_effects ORDER BY event_id`;
        const triggers = yield* sql<{
          readonly trigger_id: string;
          readonly paused_by: string | null;
          readonly spawn_bound_max_runs: number | null;
          readonly spawn_bound_window_seconds: number | null;
          readonly held_at_resume: number | null;
        }>`
          SELECT trigger_id, paused_by, spawn_bound_max_runs, spawn_bound_window_seconds,
                 held_at_resume
          FROM triggers ORDER BY trigger_id`;
        const workflows = yield* sql<{ readonly invalid_since: string | null }>`
          SELECT invalid_since FROM workflows`;
        const writes = {
          held: yield* attemptStatement(sql`
            INSERT INTO trigger_effects (workflow_id, trigger_id, event_id, state, inputs, matched_at)
            VALUES (${WORKFLOW_ID}, 'active', 3, 'held', '{}', ${MATCHED_AT})`),
          spawnedWithoutTime: yield* attemptStatement(sql`
            INSERT INTO trigger_effects (workflow_id, trigger_id, event_id, state, inputs, run_id, matched_at)
            VALUES (${WORKFLOW_ID}, 'active', 4, 'spawned', '{}', ${RUN_ID}, ${MATCHED_AT})`),
          pausedByOnActive: yield* attemptStatement(sql`
            UPDATE triggers SET paused_by = 'manual' WHERE trigger_id = 'active'`),
          breakerPause: yield* attemptStatement(sql`
            UPDATE triggers SET paused_by = 'breaker' WHERE trigger_id = 'paused'`),
          halfBound: yield* attemptStatement(sql`
            UPDATE triggers SET spawn_bound_max_runs = 3 WHERE trigger_id = 'paused'`),
        };
        return { effects, triggers, workflows, writes };
      }).pipe(Effect.provide(openDatabase(MEMORY))),
    );

    expect(checked.effects).toEqual([
      { event_id: 1, state: "spawned", has_run: 1, spawned_at: MATCHED_AT },
      { event_id: 2, state: "pending", has_run: 0, spawned_at: null },
    ]);
    expect(checked.triggers).toEqual([
      {
        trigger_id: "active",
        paused_by: null,
        spawn_bound_max_runs: 5,
        spawn_bound_window_seconds: 600,
        held_at_resume: null,
      },
      {
        trigger_id: "legacy",
        paused_by: null,
        spawn_bound_max_runs: 10_000,
        spawn_bound_window_seconds: 2_592_000,
        held_at_resume: null,
      },
      {
        trigger_id: "paused",
        paused_by: "manual",
        spawn_bound_max_runs: null,
        spawn_bound_window_seconds: null,
        held_at_resume: null,
      },
    ]);
    expect(checked.workflows).toEqual([{ invalid_since: null }]);
    expect(checked.writes.held).toBe("accepted");
    expect(checked.writes.spawnedWithoutTime).toContain("CHECK constraint failed");
    expect(checked.writes.pausedByOnActive).toContain("CHECK constraint failed");
    expect(checked.writes.breakerPause).toBe("accepted");
    expect(checked.writes.halfBound).toContain("CHECK constraint failed");
  });
});
