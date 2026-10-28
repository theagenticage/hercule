/**
 * Tests Tracking's reads against a migrated test database, with the runs port
 * replaced by a recorder:
 *
 * - which Tasks it lists: in-progress Tasks with a handoff entry, and no
 *   other;
 * - what a row holds, and the order of the rows and of their handoffs;
 * - who may read it;
 * - what `task.readTracking` returns for a Task, which Tasks it refuses, and
 *   who may read it;
 * - the query plan of the Task statements.
 *
 * The runs behind a row, and the whole read through HTTP, are tested in
 * `tracking.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { MAX_TRACKING_HANDOFFS, type Grant, type TrackingRun } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { inTransaction, TestDatabase } from "../db/testing";
import { taskRepository, type NewTask } from "./repository";
import {
  TaskTracking,
  TaskTrackingLayer,
  TaskTrackingRuns,
  type TrackedRunHistory,
  type TrackedRuns,
} from "./tracking";

const SIGNAL_A = "0199e0e7-0005-7000-8000-00000000000a";
const SIGNAL_B = "0199e0e7-0005-7000-8000-00000000000b";
const RUN_A = "0199e0e7-0006-7000-8000-00000000000a";
const RUN_B = "0199e0e7-0006-7000-8000-00000000000b";
const AT = "2026-10-20T10:00:00.000Z";

/** The workflow name the port gives for each run id it knows. */
const WORKFLOW_NAMES: ReadonlyMap<string, string> = new Map([
  [RUN_A, "Implement"],
  [RUN_B, "Review"],
]);
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

const NO_HISTORY: TrackedRunHistory = {
  runs: [],
  agentStep: undefined,
  endingActionStepName: undefined,
};

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
 * `asked` collects the ids the port was asked about. When `liveRunIds` is
 * given, the port also reports those live runs for every Task, the first being
 * the newest and `latestLiveRun`.
 */
const runTracking = <A, E>(
  actor: Actor,
  asked: Array<ReadonlyArray<string>>,
  body: Effect.Effect<A, E, SqlClient.SqlClient | TaskTracking>,
  liveRunIds: ReadonlyArray<string> = [],
  history: TrackedRunHistory = NO_HISTORY,
) =>
  Effect.runPromise(
    body.pipe(
      Effect.provideService(CurrentActor, actor),
      Effect.provide(
        TaskTrackingLayer.pipe(
          Layer.provide(
            Layer.succeed(TaskTrackingRuns)({
              readRunHistory: () => Effect.succeed(history),
              readTaskIds: () => Effect.succeed(new Map()),
              readLegRuns: () => Effect.succeed([]),
              readWorkflowNames: () => Effect.succeed(new Map()),
              readWorkflowName: (runId) =>
                Effect.succeed(Option.fromNullishOr(WORKFLOW_NAMES.get(runId))),
              readLatestRuns: (taskIds) =>
                Effect.sync(() => {
                  asked.push(taskIds);
                  return taskIds.map((taskId): TrackedRuns => ({
                    taskId,
                    latestRun: buildRun(RUN_A),
                    ...(liveRunIds[0] === undefined
                      ? {}
                      : { latestLiveRun: { ...buildRun(liveRunIds[0]), status: "running" } }),
                    liveRunIds,
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

  it("gives each row its handoffs newest first, and orders the rows by the Task's last update, newest first", async () => {
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
      { signalId: SIGNAL_B, runId: RUN_B, at: "2026-10-20T12:00:00.000Z" },
      { signalId: SIGNAL_A, runId: RUN_A, at: LATER },
    ]);
    expect(rows[0]).toMatchObject({ latestRun: buildRun(RUN_A) });
    expect(rows[0]).not.toHaveProperty("latestLiveRun");
    expect(rows[0]!.liveRunIds).toEqual([]);
  });

  it("gives each row the ids of all the Task's live runs, newest first, beside the newest live run", async () => {
    const rows = await runTracking(
      USER,
      [],
      Effect.gen(function* () {
        const repository = yield* taskRepository;
        yield* inTransaction(
          repository.insert({
            ...NEW_TASK,
            title: "two live runs",
            provenance: [{ signalId: SIGNAL_A, runId: RUN_A }],
          }),
        );
        const tracking = yield* TaskTracking;
        return (yield* tracking.query()).rows;
      }),
      [RUN_B, RUN_A],
    );

    expect(rows[0]).toMatchObject({
      latestLiveRun: { id: RUN_B },
      liveRunIds: [RUN_B, RUN_A],
    });
  });

  it("returns only the newest handoffs of a Task that was handed many, newest first", async () => {
    const total = MAX_TRACKING_HANDOFFS + 5;
    const rows = await runTracking(
      USER,
      [],
      Effect.gen(function* () {
        const repository = yield* taskRepository;
        yield* inTransaction(
          Effect.gen(function* () {
            const task = yield* repository.insert({ ...NEW_TASK, title: "handed often" });
            for (let n = 1; n <= total; n++) {
              yield* repository.update(
                task.id,
                {},
                [{ signalId: SIGNAL_A, runId: RUN_A }],
                `2026-10-20T12:${String(n).padStart(2, "0")}:00.000Z`,
                "user",
              );
            }
          }),
        );
        const tracking = yield* TaskTracking;
        return (yield* tracking.query()).rows;
      }),
    );

    expect(rows[0]!.handoffs.map((handoff) => handoff.at)).toEqual(
      Array.from(
        { length: MAX_TRACKING_HANDOFFS },
        (_, index) => `2026-10-20T12:${String(total - index).padStart(2, "0")}:00.000Z`,
      ),
    );
  });

  it("orders handoffs that share a time by the order they were appended, newest first", async () => {
    const rows = await runTracking(
      USER,
      [],
      Effect.gen(function* () {
        const repository = yield* taskRepository;
        yield* inTransaction(
          repository.insert({
            ...NEW_TASK,
            title: "handed twice at once",
            provenance: [
              { signalId: SIGNAL_A, runId: RUN_A },
              { signalId: SIGNAL_B, runId: RUN_B },
            ],
          }),
        );
        const tracking = yield* TaskTracking;
        return (yield* tracking.query()).rows;
      }),
    );

    expect(rows[0]!.handoffs).toEqual([
      { signalId: SIGNAL_B, runId: RUN_B, at: AT },
      { signalId: SIGNAL_A, runId: RUN_A, at: AT },
    ]);
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
              Layer.succeed(TaskTrackingRuns)({
                readLatestRuns: () => Effect.succeed([]),
                readRunHistory: () => Effect.succeed(NO_HISTORY),
                readTaskIds: () => Effect.succeed(new Map()),
                readLegRuns: () => Effect.succeed([]),
                readWorkflowNames: () => Effect.succeed(new Map()),
                readWorkflowName: () => Effect.succeed(Option.none()),
              }),
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

describe("task.readTracking", () => {
  const AGENT_STEP = {
    stepName: "Review",
    sessionId: "0199e0e7-0007-7000-8000-00000000000a",
    output: { text: "All good." },
    outputSchema: undefined,
  };

  /** Writes a Task with the handoffs `provenance` lists and returns its id. */
  const insertTask = (fields: Partial<NewTask>) =>
    Effect.gen(function* () {
      const repository = yield* taskRepository;
      return (yield* inTransaction(repository.insert({ ...NEW_TASK, ...fields }))).id;
    });

  it("returns the Task's oldest handoff as the first one, whatever order the handoffs were made in", async () => {
    const detail = await runTracking(
      USER,
      [],
      Effect.gen(function* () {
        const repository = yield* taskRepository;
        const taskId = yield* insertTask({
          provenance: [{ signalId: SIGNAL_A, runId: RUN_A }],
        });
        yield* inTransaction(
          repository.update(
            taskId,
            {},
            [{ signalId: SIGNAL_B, runId: RUN_B }],
            "2026-10-20T12:00:00.000Z",
            "user",
          ),
        );
        return yield* Effect.flatMap(TaskTracking, (tracking) => tracking.read(taskId));
      }),
      [],
      { runs: [{ ...buildRun(RUN_A) }], agentStep: undefined, endingActionStepName: undefined },
    );

    expect(detail.firstHandoff).toEqual({
      signalId: SIGNAL_A,
      runId: RUN_A,
      at: AT,
      workflowName: "Implement",
    });
    expect(detail.runs.map((run) => run.id)).toEqual([RUN_A]);
    expect(detail).not.toHaveProperty("output");
    expect(detail).not.toHaveProperty("endingActionStepName");
  });

  it("shapes the newest run's last agent step into the output, and names the action step the run ended on", async () => {
    const detail = await runTracking(
      USER,
      [],
      Effect.gen(function* () {
        const taskId = yield* insertTask({ provenance: [{ signalId: SIGNAL_A, runId: RUN_A }] });
        return yield* Effect.flatMap(TaskTracking, (tracking) => tracking.read(taskId));
      }),
      [],
      {
        runs: [buildRun(RUN_A)],
        agentStep: AGENT_STEP,
        endingActionStepName: "Open the pull request",
      },
    );

    expect(detail.output).toEqual({
      kind: "text",
      stepName: "Review",
      sessionId: AGENT_STEP.sessionId,
      text: "All good.",
    });
    expect(detail.endingActionStepName).toBe("Open the pull request");
  });

  it.each([
    ["does not exist", undefined],
    ["has no provenance", []],
    ["only has a ref", [{ ref: "github:issue:o/r#1" }]],
  ] as const)("fails with not_found for a Task that %s", async (_, provenance) => {
    const error = await runTracking(
      USER,
      [],
      Effect.gen(function* () {
        const taskId =
          provenance === undefined
            ? "0199e0e7-0004-7000-8000-0000000000ff"
            : yield* insertTask({ provenance });
        return yield* Effect.flip(
          Effect.flatMap(TaskTracking, (tracking) => tracking.read(taskId)),
        );
      }),
    );

    expect(error).toMatchObject({ error: { code: "not_found" } });
  });

  it("names the workflow of the first handoff's run, which the run history need not hold", async () => {
    const detail = await runTracking(
      USER,
      [],
      Effect.gen(function* () {
        const repository = yield* taskRepository;
        const taskId = yield* insertTask({
          provenance: [{ signalId: SIGNAL_A, runId: RUN_B }],
        });
        yield* inTransaction(
          repository.update(
            taskId,
            {},
            [{ signalId: SIGNAL_B, runId: RUN_A }],
            "2026-10-20T12:00:00.000Z",
            "user",
          ),
        );
        return yield* Effect.flatMap(TaskTracking, (tracking) => tracking.read(taskId));
      }),
      [],
      { runs: [buildRun(RUN_A)], agentStep: undefined, endingActionStepName: undefined },
    );

    expect(detail.firstHandoff).toMatchObject({ runId: RUN_B, workflowName: "Review" });
  });

  it("fails with not_found when the run of the first handoff does not exist", async () => {
    const error = await runTracking(
      USER,
      [],
      Effect.gen(function* () {
        const taskId = yield* insertTask({
          provenance: [{ signalId: SIGNAL_A, runId: "0199e0e7-0006-7000-8000-0000000000ff" }],
        });
        return yield* Effect.flip(
          Effect.flatMap(TaskTracking, (tracking) => tracking.read(taskId)),
        );
      }),
    );

    expect(error).toMatchObject({ error: { code: "not_found" } });
  });

  it("fails with not_found for a deleted Task", async () => {
    const error = await runTracking(
      USER,
      [],
      Effect.gen(function* () {
        const repository = yield* taskRepository;
        const taskId = yield* insertTask({ provenance: [{ signalId: SIGNAL_A, runId: RUN_A }] });
        yield* inTransaction(repository.softDelete(taskId, AT));
        return yield* Effect.flip(
          Effect.flatMap(TaskTracking, (tracking) => tracking.read(taskId)),
        );
      }),
    );

    expect(error).toMatchObject({ error: { code: "not_found" } });
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
        Effect.flip(
          Effect.flatMap(TaskTracking, (tracking) =>
            tracking.read("0199e0e7-0004-7000-8000-0000000000ff"),
          ),
        ),
      );

      expect(error).toMatchObject({ error: { code: "forbidden", details: { grant: missing } } });
    },
  );
});

describe("the query plan of Tracking's Task statement", () => {
  it("walks the in-progress Tasks and probes each one's newest handoffs, never the handoffs of other Tasks", async () => {
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

    expect(plan).toContain("SEARCH t USING INDEX tasks_status_updated_at (status=?)");
    expect(plan).toContain(
      "SEARCH task_provenance USING INDEX task_provenance_handoff (task_id=?)",
    );
    expect(plan).toContain("SEARCH p USING INTEGER PRIMARY KEY (rowid=?)");
    expect(plan.some((step) => step.startsWith("SCAN"))).toBe(false);
    expect(plan.some((step) => step.includes("TEMP B-TREE"))).toBe(false);
  });
});

describe("the query plan of the first handoff", () => {
  it("reads the Task by key and one entry of its handoffs on task_provenance_handoff", async () => {
    const plan = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tasks = yield* taskRepository;
        const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
        yield* tasks.readFirstHandoff("0199e0e7-0004-7000-8000-0000000000ff").pipe(
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

    expect(plan).toContain("SEARCH t USING INDEX sqlite_autoindex_tasks_1 (id=?)");
    expect(plan).toContain(
      "SEARCH task_provenance USING INDEX task_provenance_handoff (task_id=?)",
    );
    expect(plan.some((step) => step.startsWith("SCAN"))).toBe(false);
  });
});
