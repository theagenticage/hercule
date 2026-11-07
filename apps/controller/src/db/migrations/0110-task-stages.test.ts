/**
 * Tests what the task stages migration does to a database at the previous
 * head: every Task takes the stage its status reads, `stage_changed_at` takes
 * `status_changed_at`, nothing else on the row moves, and the check refuses a
 * stage that does not exist.
 *
 * The tests stop at this migration, so a later migration cannot change what
 * they check.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../migrate";
import { TestDatabaseWriter } from "../testing";
import { migrations } from "./index";

const BEFORE = migrations.filter(([id]) => id < 110);
const UP_TO_TASK_STAGES = migrations.filter(([id]) => id <= 110);

const CREATED = "2026-10-01T00:00:00.000Z";
const UPDATED = "2026-10-05T00:00:00.000Z";
const STATUS_CHANGED = "2026-10-03T00:00:00.000Z";

/** One Task per status, with an id the test can tell apart. */
const STATUSES = ["open", "in-progress", "done", "cancelled"] as const;

/** Writes one Task per status, with three different times, as the previous head stores them. */
const insertTasks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* Effect.forEach(
    STATUSES,
    (status, index) =>
      sql`INSERT INTO tasks (id, title, description, status, priority, labels, created_at, updated_at, status_changed_at)
        VALUES (unhex(${`0199e0e77b2170008000000000000b0${String(index)}`}), ${status}, '', ${status}, 'normal', '[]',
                ${CREATED}, ${UPDATED}, ${STATUS_CHANGED})`,
  );
});

describe("the task stages migration", () => {
  it("gives each existing Task the stage its status reads, and moves no other column", async () => {
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* insertTasks;
        yield* runMigrations(UP_TO_TASK_STAGES);
        return yield* sql`
          SELECT status, stage, stage_changed_at, status_changed_at, updated_at
          FROM tasks ORDER BY id`;
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(rows).toEqual(
      [
        ["open", "planned"],
        ["in-progress", "building"],
        ["done", "done"],
        ["cancelled", "dropped"],
      ].map(([status, stage]) => ({
        status,
        stage,
        stage_changed_at: STATUS_CHANGED,
        status_changed_at: STATUS_CHANGED,
        updated_at: UPDATED,
      })),
    );
  });

  it("refuses a stage that does not exist, and accepts each of the seven", async () => {
    const outcomes = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(UP_TO_TASK_STAGES);
        yield* insertTasks;
        const stages = [
          "exploring",
          "planned",
          "building",
          "in-review",
          "landed",
          "done",
          "dropped",
        ];
        const accepted = yield* Effect.forEach(stages, (stage) =>
          Effect.exit(sql`UPDATE tasks SET stage = ${stage} WHERE title = 'open'`),
        );
        const refused = yield* Effect.exit(sql`UPDATE tasks SET stage = 'reviewing'`);
        return [...accepted, refused].map(Exit.isFailure);
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(outcomes).toEqual([false, false, false, false, false, false, false, true]);
  });
});
