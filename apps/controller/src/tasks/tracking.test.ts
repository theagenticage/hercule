/**
 * Tests Tracking's read against a migrated test database, with the runs port
 * replaced by a recorder:
 *
 * - which Tasks it lists: in-progress Tasks with a handoff entry, and no
 *   other;
 * - what a row holds, and the order of the rows and of their handoffs;
 * - who may read it;
 * - the query plan of the Task statement.
 *
 * The runs behind a row, and the whole read through HTTP, are tested in
 * `tracking.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Statement from "effect/unstable/sql/Statement";
import type { Grant, TrackingRun } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { inTransaction, TestDatabase } from "../db/testing";
import { taskRepository, type NewTask } from "./repository";
import { TaskTracking, TaskTrackingLayer, TaskTrackingRuns, type TrackedRuns } from "./tracking";

const SIGNAL_A = "0199e0e7-0005-7000-8000-00000000000a";
const SIGNAL_B = "0199e0e7-0005-7000-8000-00000000000b";
const RUN_A = "0199e0e7-0006-7000-8000-00000000000a";
const RUN_B = "0199e0e7-0006-7000-8000-00000000000b";
const AT = "2026-10-20T10:00:00.000Z";
const LATER = "2026-10-20T11:00:00.000Z";

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

const buildRun = (id: string): TrackingRun => ({
  id,
  workflowId: null,
  workflowName: "Implement",
  status: "completed",
  createdAt: AT,
  awaitedSignalIds: [],
});

const NEW_TASK: NewTask = {
  title: "A task",
  description: "",
  status: "in-progress",
  priority: "normal",
  labels: [],
  projectId: undefined,
  provenance: [],
  at: AT,
  actor: "user",
};

/**
 * Builds the Tracking read over a fresh database and a port that returns a
 * completed run for every Task it is asked about, and runs `body` as `actor`.
 * `asked` collects the ids the port was asked about.
 */
const runTracking = <A, E>(
  actor: Actor,
  asked: Array<ReadonlyArray<string>>,
  body: Effect.Effect<A, E, SqlClient.SqlClient | TaskTracking>,
) =>
  Effect.runPromise(
    body.pipe(
      Effect.provideService(CurrentActor, actor),
      Effect.provide(
        TaskTrackingLayer.pipe(
          Layer.provide(
            Layer.succeed(TaskTrackingRuns)({
              readLatestRuns: (taskIds) =>
                Effect.sync(() => {
                  asked.push(taskIds);
                  return taskIds.map((taskId): TrackedRuns => ({
                    taskId,
                    latestRun: buildRun(RUN_A),
                  }));
                }),
            }),
          ),
          Layer.provideMerge(TestDatabase),
        ),
      ),
    ),
  );

describe("task.queryTracking", () => {
  it("lists the in-progress Tasks that have a handoff entry, and no other Task", async () => {
    const asked: Array<ReadonlyArray<string>> = [];
    const titles = await runTracking(
      USER,
      asked,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* taskRepository;
        const handoff = { signalId: SIGNAL_A, runId: RUN_A };
        yield* inTransaction(
          Effect.gen(function* () {
            yield* rows.insert({ ...NEW_TASK, title: "tracked", provenance: [handoff] });
            yield* rows.insert({ ...NEW_TASK, title: "no handoff" });
            yield* rows.insert({
              ...NEW_TASK,
              title: "only a ref",
              provenance: [{ ref: "github:issue:o/r#1" }],
            });
            yield* rows.insert({
              ...NEW_TASK,
              title: "open",
              status: "open",
              provenance: [handoff],
            });
            yield* rows.insert({
              ...NEW_TASK,
              title: "done",
              status: "done",
              provenance: [handoff],
            });
            const deleted = yield* rows.insert({
              ...NEW_TASK,
              title: "deleted",
              provenance: [handoff],
            });
            yield* rows.softDelete(deleted.id, AT);
          }),
        ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
        const tracking = yield* TaskTracking;
        return (yield* tracking.query()).rows.map((row) => row.title);
      }),
    );

    expect(titles).toEqual(["tracked"]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toHaveLength(1);
  });

  it("gives each row its handoffs oldest first, and orders the rows by the Task's last update, newest first", async () => {
    const rows = await runTracking(
      USER,
      [],
      Effect.gen(function* () {
        const repository = yield* taskRepository;
        yield* inTransaction(
          Effect.gen(function* () {
            yield* repository.insert({
              ...NEW_TASK,
              title: "older",
              provenance: [{ signalId: SIGNAL_A, runId: RUN_A }],
            });
            const newer = yield* repository.insert({
              ...NEW_TASK,
              title: "newer",
              at: LATER,
              provenance: [{ signalId: SIGNAL_A, runId: RUN_A }],
            });
            // A second handoff, appended after the first.
            yield* repository.update(
              newer.id,
              {},
              [{ signalId: SIGNAL_B, runId: RUN_B }],
              "2026-10-20T12:00:00.000Z",
              "user",
            );
          }),
        );
        const tracking = yield* TaskTracking;
        return (yield* tracking.query()).rows;
      }),
    );

    expect(rows.map((row) => row.title)).toEqual(["newer", "older"]);
    expect(rows[0]!.handoffs).toEqual([
      { signalId: SIGNAL_A, runId: RUN_A, at: LATER },
      { signalId: SIGNAL_B, runId: RUN_B, at: "2026-10-20T12:00:00.000Z" },
    ]);
    expect(rows[0]).toMatchObject({ latestRun: buildRun(RUN_A) });
    expect(rows[0]).not.toHaveProperty("latestLiveRun");
  });

  it("leaves out a Task that has no run", async () => {
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* taskRepository;
        yield* inTransaction(
          repository.insert({
            ...NEW_TASK,
            provenance: [{ signalId: SIGNAL_A, runId: RUN_A }],
          }),
        );
        const tracking = yield* TaskTracking;
        return (yield* tracking.query()).rows;
      }).pipe(
        Effect.provideService(CurrentActor, USER),
        Effect.provide(
          TaskTrackingLayer.pipe(
            Layer.provide(
              Layer.succeed(TaskTrackingRuns)({ readLatestRuns: () => Effect.succeed([]) }),
            ),
            Layer.provideMerge(TestDatabase),
          ),
        ),
      ),
    );

    expect(rows).toEqual([]);
  });

  it("lets a session read it when its profile holds both the task and the run read grant, as it can read the same facts from those operations", async () => {
    const rows = await runTracking(
      buildSession(["task.read", "run.read"]),
      [],
      Effect.flatMap(TaskTracking, (tracking) => tracking.query()),
    );

    expect(rows).toEqual({ rows: [] });
  });

  it.each([
    ["the task read grant", ["run.read"], "task.read"],
    ["the run read grant", ["task.read"], "run.read"],
  ] as const)(
    "refuses a session that lacks %s, and names the grant",
    async (_, grants, missing) => {
      const error = await runTracking(
        buildSession(grants),
        [],
        Effect.flip(Effect.flatMap(TaskTracking, (tracking) => tracking.query())),
      );

      expect(error).toMatchObject({ error: { code: "forbidden", details: { grant: missing } } });
    },
  );
});

describe("the query plan of Tracking's Task statement", () => {
  it("walks the entries that name a signal and reads each Task by its key, never the status index", async () => {
    const plan = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tasks = yield* taskRepository;
        const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
        yield* tasks.listTracked().pipe(
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

    expect(plan).toContain("SEARCH p USING INDEX task_provenance_signal (signal_id>?)");
    expect(plan).toContain("SEARCH t USING INDEX sqlite_autoindex_tasks_1 (id=?)");
    expect(plan.some((step) => step.includes("tasks_status"))).toBe(false);
    expect(plan.some((step) => step.startsWith("SCAN"))).toBe(false);
  });
});
