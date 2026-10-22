/**
 * Tests `task.queryLegs` against a migrated test database and the real
 * `TaskTrackingRuns` port, because what a leg holds comes from how the runs
 * point at each other:
 *
 * - which runs a leg holds: re-runs of re-runs, never by time, never another
 *   Task's runs;
 * - the Task's next handoff, in append order;
 * - which ids are left out, the order of the legs, and duplicates;
 * - the newest run of a leg, why it failed, and the cap on its live runs;
 * - who may read it;
 * - the query plan of the two statements.
 *
 * The route and the URL encoding of the ids are tested in
 * `tracking.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Statement from "effect/unstable/sql/Statement";
import { MAX_LEG_LIVE_RUNS, type Grant, type RunStatus } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { TaskTrackingRunsLayer } from "../daemon/runs";
import { uuidFromString } from "../db";
import { inTransaction, TestDatabase } from "../db/testing";
import { runRepository } from "../runs/repository";
import { taskRepository } from "./repository";
import { TaskTracking, TaskTrackingLayer } from "./tracking";

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

const buildSession = (grants: ReadonlyArray<Grant>): Actor => ({
  _tag: "session",
  sessionId: "0199e0e7-0002-7000-8000-000000000000",
  profileId: "0199e0e7-0003-7000-8000-000000000000",
  grants,
  profileGrants: grants,
  assistantId: null,
  agentId: null,
});

/** The id of the `n`-th thing of a kind, so a test reads its ids by name. */
const buildId = (kind: "task" | "signal" | "run", n: number) =>
  `0199e0e7-${{ task: "0004", signal: "0005", run: "0006" }[kind]}-7000-8000-${n.toString(16).padStart(12, "0")}`;

const TASK = buildId("task", 1);
const OTHER_TASK = buildId("task", 2);
const AT = "2026-10-20T10:00:00.000Z";
const minute = (n: number) => `2026-10-20T11:${String(n).padStart(2, "0")}:00.000Z`;

/** Writes an in-progress Task whose handoff entries are `handoffs`, in that append order, all at `AT`. */
const insertTask = (
  id: string,
  handoffs: ReadonlyArray<{ readonly signal: number; readonly run: number }>,
) =>
  Effect.gen(function* () {
    const tasks = yield* taskRepository;
    yield* tasks.insert({
      id,
      title: "A task",
      description: "",
      status: "in-progress",
      priority: "normal",
      labels: [],
      projectId: undefined,
      provenance: handoffs.map(({ signal, run }) => ({
        signalId: buildId("signal", signal),
        runId: buildId("run", run),
      })),
      at: AT,
      actor: "user",
    });
  }).pipe(inTransaction);

interface RunToWrite {
  readonly id: number;
  readonly task?: string;
  /** The run this one re-runs. */
  readonly rerunOf?: number;
  readonly at: string;
  readonly status?: RunStatus;
  readonly workflow?: string;
}

/** Writes a run, directly, so a test chooses its creation time and the run it re-runs. */
const insertRun = (run: RunToWrite) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const status = run.status ?? "completed";
    yield* sql`
      INSERT INTO runs (id, plan, inputs, origin, task_id, original_run_id, status, failure_reason,
                        failed_step_id, failure_message, created_at, started_at, finished_at)
      VALUES (${uuidFromString(buildId("run", run.id))},
              ${JSON.stringify({ name: run.workflow ?? "Implement", steps: [] })}, '{}',
              '{"kind":"manual","actor":"user"}',
              ${run.task === undefined ? null : uuidFromString(run.task)},
              ${run.rerunOf === undefined ? null : uuidFromString(buildId("run", run.rerunOf))},
              ${status}, ${status === "failed" ? "step-failed" : null},
              ${status === "failed" ? "work" : null},
              ${status === "failed" ? "permission denied on ops-db" : null}, ${run.at},
              ${status === "pending" ? null : run.at},
              ${status === "pending" || status === "running" ? null : run.at})`;
  }).pipe(inTransaction);

const runLegs = <A, E>(
  body: Effect.Effect<A, E, SqlClient.SqlClient | TaskTracking>,
  actor: Actor = USER,
) =>
  Effect.runPromise(
    body.pipe(
      Effect.provideService(CurrentActor, actor),
      Effect.provide(
        TaskTrackingLayer.pipe(
          Layer.provideMerge(TaskTrackingRunsLayer),
          Layer.provideMerge(TestDatabase),
        ),
      ),
    ),
  );

const queryLegs = (runIds: ReadonlyArray<number>) =>
  Effect.flatMap(TaskTracking, (tracking) =>
    tracking.queryLegs(runIds.map((n) => buildId("run", n))),
  );

describe("task.queryLegs", () => {
  it("gives a handoff nothing re-ran its own run as the newest run, with no next handoff", async () => {
    const { legs } = await runLegs(
      Effect.gen(function* () {
        yield* insertTask(TASK, [{ signal: 1, run: 1 }]);
        yield* insertRun({ id: 1, task: TASK, at: minute(1), workflow: "Review PR" });
        return yield* queryLegs([1]);
      }),
    );

    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({
      runId: buildId("run", 1),
      signalId: buildId("signal", 1),
      taskId: TASK,
      taskStatus: "in-progress",
      workflowId: null,
      workflowName: "Review PR",
      rerunCount: 0,
      latestRun: { id: buildId("run", 1), status: "completed" },
      liveRunIds: [],
    });
    expect(legs[0]).not.toHaveProperty("next");
  });

  it("holds a leg's re-runs by what they re-run, however deep, and never by when they started or by their Task", async () => {
    const { legs } = await runLegs(
      Effect.gen(function* () {
        // Handoff A (run 1) and handoff B (run 2) on one Task. A is re-run, and its
        // re-run is re-run, after B started: run 4 is newer than all of B's runs.
        yield* insertTask(TASK, [
          { signal: 1, run: 1 },
          { signal: 2, run: 2 },
        ]);
        yield* insertRun({ id: 1, task: TASK, at: minute(1) });
        yield* insertRun({ id: 2, task: TASK, at: minute(2) });
        yield* insertRun({ id: 3, task: TASK, rerunOf: 1, at: minute(3) });
        yield* insertRun({ id: 4, task: TASK, rerunOf: 3, at: minute(10) });
        // B is re-run twice, both times directly.
        yield* insertRun({ id: 5, task: TASK, rerunOf: 2, at: minute(4) });
        yield* insertRun({ id: 6, task: TASK, rerunOf: 2, at: minute(5) });
        // A run of another Task that re-runs run 1 is not part of the leg.
        yield* insertRun({ id: 7, task: OTHER_TASK, rerunOf: 1, at: minute(20) });
        return yield* queryLegs([1, 2]);
      }),
    );

    expect(legs.map((leg) => [leg.runId, leg.rerunCount, leg.latestRun.id])).toEqual([
      [buildId("run", 1), 2, buildId("run", 4)],
      [buildId("run", 2), 2, buildId("run", 6)],
    ]);
  });

  it("gives the next handoff in append order, whatever the entries' times", async () => {
    const { legs } = await runLegs(
      Effect.gen(function* () {
        yield* insertTask(TASK, [
          { signal: 1, run: 1 },
          { signal: 2, run: 2 },
          { signal: 3, run: 3 },
        ]);
        yield* insertRun({ id: 1, task: TASK, at: minute(1) });
        yield* insertRun({ id: 2, task: TASK, at: minute(2), workflow: "Review PR" });
        yield* insertRun({ id: 3, task: TASK, at: minute(3), workflow: "Ship" });
        // The first entry now has the latest time; the other two share a time.
        const sql = yield* SqlClient.SqlClient;
        yield* inTransaction(
          sql`UPDATE task_provenance SET at = '2026-10-21T10:00:00.000Z'
              WHERE run_id = ${uuidFromString(buildId("run", 1))}`,
        );
        // Asked for only the first and the last, so the next of the first is not asked for.
        return yield* queryLegs([1, 3]);
      }),
    );

    expect(legs[0]!.next).toEqual({
      signalId: buildId("signal", 2),
      runId: buildId("run", 2),
      at: AT,
      workflowName: "Review PR",
    });
    expect(legs[1]!.next).toBeUndefined();
  });

  it("leaves out ids that are not the run of a handoff of a Task that exists, keeps the order asked, and gives a repeated id once", async () => {
    const { legs } = await runLegs(
      Effect.gen(function* () {
        yield* insertTask(TASK, [{ signal: 1, run: 1 }]);
        yield* insertRun({ id: 1, task: TASK, at: minute(1) });
        // A re-run of the handoff's run: on the Task, but not a handoff's run.
        yield* insertRun({ id: 2, task: TASK, rerunOf: 1, at: minute(2) });
        // A run that no Task owns.
        yield* insertRun({ id: 3, at: minute(3) });
        // A handoff of a deleted Task.
        yield* insertTask(OTHER_TASK, [{ signal: 4, run: 4 }]);
        yield* insertRun({ id: 4, task: OTHER_TASK, at: minute(4) });
        const sql = yield* SqlClient.SqlClient;
        yield* inTransaction(
          sql`UPDATE tasks SET deleted_at = ${AT} WHERE id = ${uuidFromString(OTHER_TASK)}`,
        );
        // A handoff entry whose run works on another Task than the entry's.
        const third = buildId("task", 3);
        yield* insertTask(third, [{ signal: 5, run: 5 }]);
        yield* insertRun({ id: 5, task: TASK, at: minute(5) });
        // A second handoff, after the first, to show the order asked is kept.
        yield* insertTask(buildId("task", 4), [{ signal: 6, run: 6 }]);
        yield* insertRun({ id: 6, task: buildId("task", 4), at: minute(6) });
        return yield* queryLegs([6, 2, 3, 4, 5, 99, 1, 6]);
      }),
    );

    expect(legs.map((leg) => leg.runId)).toEqual([buildId("run", 6), buildId("run", 1)]);
  });

  it("says why the newest run failed, and lists the live runs newest first up to the cap", async () => {
    const live = MAX_LEG_LIVE_RUNS + 5;
    const { legs } = await runLegs(
      Effect.gen(function* () {
        yield* insertTask(TASK, [{ signal: 1, run: 1 }]);
        yield* insertRun({ id: 1, task: TASK, at: minute(1), status: "running" });
        for (let n = 1; n <= live; n++) {
          yield* insertRun({
            id: 100 + n,
            task: TASK,
            rerunOf: 1,
            at: minute(2),
            status: "pending",
          });
        }
        yield* insertRun({ id: 2, task: TASK, rerunOf: 1, at: minute(30), status: "failed" });
        return yield* queryLegs([1]);
      }),
    );

    const leg = legs[0]!;
    expect(leg.rerunCount).toBe(live + 1);
    expect(leg.latestRun).toMatchObject({
      id: buildId("run", 2),
      status: "failed",
      failureCause: "permission denied on ops-db",
    });
    // The 25 pending re-runs and the running root are live; the cap keeps the newest 20,
    // which share a time, so the greatest ids come first.
    expect(leg.liveRunIds).toHaveLength(MAX_LEG_LIVE_RUNS);
    expect(leg.liveRunIds[0]).toBe(buildId("run", 100 + live));
    expect(leg.liveRunIds.at(-1)).toBe(buildId("run", 100 + live - MAX_LEG_LIVE_RUNS + 1));
  });

  it("lets a session read it when its profile holds the task and the run read grant", async () => {
    const result = await runLegs(queryLegs([1]), buildSession(["task.read", "run.read"]));

    expect(result).toEqual({ legs: [] });
  });

  it.each([
    ["the task read grant", ["run.read"], "task.read"],
    ["the run read grant", ["task.read"], "run.read"],
  ] as const)(
    "refuses a session that lacks %s, and names the grant",
    async (_, grants, missing) => {
      const error = await runLegs(Effect.flip(queryLegs([1])), buildSession(grants));

      expect(error).toMatchObject({ error: { code: "forbidden", details: { grant: missing } } });
    },
  );
});

describe("the query plans of task.queryLegs", () => {
  /** Returns the plan SQLite gives the first statement `read` sends. */
  const planOf = <E>(read: Effect.Effect<unknown, E, SqlClient.SqlClient>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
        yield* read.pipe(
          Effect.provideService(Statement.CurrentTransformer, (statement) =>
            Effect.sync(() => {
              statements.push(statement.compile());
              return statement;
            }),
          ),
        );
        const [text, params] = statements[0]!;
        const rows = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${text}`,
          params,
        );
        return rows.map((row) => row.detail);
      }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
    );

  it("finds a handoff by its Task on task_provenance_handoff, and its next entry on the same index", async () => {
    const plan = await planOf(
      Effect.flatMap(taskRepository, (tasks) =>
        tasks.listLegHandoffs([{ runId: buildId("run", 1), taskId: TASK }]),
      ),
    );

    expect(plan).toContain("SEARCH t USING INDEX sqlite_autoindex_tasks_1 (id=?)");
    // Once for the entry of the run, once inside the subquery for the next entry.
    expect(
      plan.filter((step) => step.endsWith("USING INDEX task_provenance_handoff (task_id=?)")),
    ).toHaveLength(2);
    expect(plan.some((step) => step.startsWith("SCAN task_provenance"))).toBe(false);
  });

  it("walks the roots by key and each run's re-runs on runs_original_run_id", async () => {
    const plan = await planOf(
      Effect.flatMap(runRepository, (runs) =>
        runs.listLegs([{ runId: buildId("run", 1), taskId: TASK }], MAX_LEG_LIVE_RUNS),
      ),
    );

    expect(plan).toContain("SEARCH runs USING INDEX sqlite_autoindex_runs_1 (id=?)");
    expect(plan).toContain("SEARCH runs USING INDEX runs_original_run_id (original_run_id=?)");
    // The Task's whole run history is never walked.
    expect(plan.some((step) => step.includes("runs_task_id"))).toBe(false);
    expect(plan.some((step) => step.startsWith("SCAN runs"))).toBe(false);
  });
});
