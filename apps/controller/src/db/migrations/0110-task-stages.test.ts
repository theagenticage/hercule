/**
 * Tests what the task stages migration does to a database at the previous
 * head: every Task takes the stage the migration maps its status to, `stage_changed_at` takes
 * `status_changed_at`, nothing else on the row moves, and the check refuses a
 * stage that does not exist.
 *
 * The tests of the data stop at this migration, so a later migration cannot
 * change what they check. The tests of the indexes run on the newest database,
 * because they check that the listings the task repository really builds still
 * find these indexes there.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { projectRepository } from "../../projects";
import { taskRepository, type TaskFilter, type TaskOrder } from "../../tasks/repository";
import { runMigrations } from "../migrate";
import { inTransaction, TestDatabase, TestDatabaseWriter } from "../testing";
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
  it("gives each existing Task the stage its status maps to, and moves no other column", async () => {
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

/**
 * Runs one page of the task repository's listing and returns the steps of the
 * query plan SQLite makes for the listing's own statement. A cursor is passed
 * for a later page. Also returns the cursor that follows the page.
 */
const explainTaskListing = (
  filter: TaskFilter,
  order: TaskOrder,
  limit: number,
  cursor: string | undefined,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tasks = yield* taskRepository;
    const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
    const page = yield* tasks.list(filter, { limit, cursor, order }).pipe(
      Effect.provideService(Statement.CurrentTransformer, (statement) =>
        Effect.sync(() => {
          statements.push(statement.compile());
          return statement;
        }),
      ),
    );
    // The listing's own statement is the first one; the second reads the
    // provenance of the page.
    const [text, params] = statements[0]!;
    const rows = yield* sql.unsafe<{ readonly detail: string }>(
      `EXPLAIN QUERY PLAN ${text}`,
      params,
    );
    return { plan: rows.map((row) => row.detail), nextCursor: page.nextCursor };
  });

const AT = "2026-10-01T00:00:00.000Z";

/** Writes three planned Tasks in one project, so a first page has a next page. */
const insertPlannedTasks = Effect.gen(function* () {
  const projects = yield* projectRepository;
  const tasks = yield* taskRepository;
  const project = yield* projects.insert({ name: "Website", description: undefined, at: AT });
  yield* Effect.forEach(["a", "b", "c"], (title) =>
    tasks.insert({
      title,
      description: "",
      stage: "planned",
      status: "open",
      priority: "normal",
      labels: [],
      projectId: project.id,
      provenance: [],
      at: AT,
      actor: "user",
    }),
  );
  return project.id;
});

describe("the query plans of the task listings by stage", () => {
  it("serves `task list --stage x` from tasks_stage, with no sort of its own, on every page", async () => {
    const plans = await Effect.runPromise(
      inTransaction(
        Effect.gen(function* () {
          yield* insertPlannedTasks;
          const order: TaskOrder = {
            _tag: "column",
            sort: [{ field: "updatedAt", direction: "desc" }],
          };
          const first = yield* explainTaskListing({ stage: ["planned"] }, order, 1, undefined);
          const later = yield* explainTaskListing(
            { stage: ["planned"] },
            order,
            1,
            first.nextCursor,
          );
          return [first.plan, later.plan];
        }),
      ).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );

    // One step each: no scan, and no temporary b-tree to sort the rows.
    expect(plans).toEqual([
      ["SEARCH tasks USING INDEX tasks_stage (stage=?)"],
      ["SEARCH tasks USING INDEX tasks_stage (stage=? AND (updated_at,id)<(?,?))"],
    ]);
  });

  it("serves the desktop's start cards from tasks_project_stage_priority, with no sort of its own, on every page", async () => {
    const plans = await Effect.runPromise(
      inTransaction(
        Effect.gen(function* () {
          const projectId = yield* insertPlannedTasks;
          // The sort the desktop sends in `startTasksQuery`.
          const order: TaskOrder = {
            _tag: "column",
            sort: [
              { field: "priority", direction: "desc" },
              { field: "createdAt", direction: "desc" },
            ],
          };
          const filter: TaskFilter = { projectId, stage: ["planned"] };
          const first = yield* explainTaskListing(filter, order, 1, undefined);
          const later = yield* explainTaskListing(filter, order, 1, first.nextCursor);
          return [first.plan, later.plan];
        }),
      ).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );

    // One step each: no scan, and no temporary b-tree to sort the rows.
    expect(plans).toEqual([
      ["SEARCH tasks USING INDEX tasks_project_stage_priority (project_id=? AND stage=?)"],
      [
        "SEARCH tasks USING INDEX tasks_project_stage_priority (project_id=? AND stage=? AND (priority_rank,created_at,id)<(?,?,?))",
      ],
    ]);
  });
});
