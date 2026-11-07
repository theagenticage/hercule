/**
 * Tests the place a Task takes on the Work board when a write puts it in a
 * cell, and the failure a Task shows: where a failure is set, what ends it,
 * and when an Undo may bring it back. A cell is the Tasks of one project at
 * one stage.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import type { BoardStage, TaskStage } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { mintUuid, uuidFromString, uuidToString, withTransaction } from "../db";
import { TestDatabase } from "../db/testing";
import { AuditLogLayer, PlatformEventsLayer } from "../events";
import { NotifierLayer } from "../notifications";
import { MAX_BOARD_RANK_LENGTH } from "./board-rank";
import { taskRepository } from "./repository";
import { TaskService, TaskServiceLayer } from "./index";

const layer = TaskServiceLayer.pipe(
  Layer.provideMerge(NotifierLayer),
  Layer.provideMerge(Layer.mergeAll(AuditLogLayer, PlatformEventsLayer)),
  Layer.provideMerge(TestDatabase),
);

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

const run = <A, E>(effect: Effect.Effect<A, E, TaskService | SqlClient.SqlClient>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(CurrentActor, USER),
      Effect.provide(layer),
      Effect.provide(TestClock.layer()),
    ),
  );

/** Writes a project and returns its id. */
const insertProject = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = mintUuid();
    yield* withTransaction(
      sql,
      sql`INSERT INTO projects (id, name, created_at, updated_at)
          VALUES (${id}, ${name}, '2026-09-04T10:00:00.000Z', '2026-09-04T10:00:00.000Z')`,
    );
    return uuidToString(id);
  });

/** Returns the titles of the cell's Tasks in rank order. */
const readCellTitles = (projectId: string | null, stage: BoardStage) =>
  Effect.gen(function* () {
    const repository = yield* taskRepository;
    const tasks = yield* TaskService;
    const ranked = yield* repository.listCellRanks({ projectId, stage });
    return yield* Effect.forEach(ranked, (entry) =>
      Effect.map(tasks.read(entry.id), (task) => task.title),
    );
  });

const createInCell = (title: string, stage: TaskStage, projectId?: string) =>
  Effect.flatMap(TaskService, (tasks) =>
    tasks.create({
      title,
      description: "",
      stage,
      ...(projectId === undefined ? {} : { projectId }),
    }),
  );

describe("the place of a Task in its cell", () => {
  it("puts a new Task last in its cell and leaves the other cells alone", async () => {
    const result = await run(
      Effect.gen(function* () {
        const project = yield* insertProject("Northwind Storefront");
        yield* createInCell("first", "planned", project);
        yield* createInCell("elsewhere", "planned");
        yield* createInCell("second", "planned", project);
        yield* createInCell("other stage", "building", project);
        yield* createInCell("third", "planned", project);
        return {
          cell: yield* readCellTitles(project, "planned"),
          noProject: yield* readCellTitles(null, "planned"),
        };
      }),
    );
    expect(result.cell).toEqual(["first", "second", "third"]);
    expect(result.noProject).toEqual(["elsewhere"]);
  });

  it.each([
    [
      "a stage change",
      (project: string) => ({
        patch: { stage: "in-review" } as const,
        destination: { projectId: project, stage: "in-review" } as const,
      }),
    ],
    [
      "a legacy status change",
      (project: string) => ({
        patch: { status: "in-progress" } as const,
        destination: { projectId: project, stage: "building" } as const,
      }),
    ],
    [
      "a project change",
      (_project: string, target: string) => ({
        patch: { projectId: target } as const,
        destination: { projectId: target, stage: "planned" } as const,
      }),
    ],
  ])("puts a Task last in its new cell after %s, and moves no other Task", async (_name, plan) => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const project = yield* insertProject("Northwind Storefront");
        const target = yield* insertProject("Northwind Support");
        const { patch, destination } = plan(project, target);
        const mover = yield* createInCell("mover", "planned", project);
        yield* createInCell("stays", "planned", project);
        yield* createInCell("already there 1", destination.stage, destination.projectId);
        yield* createInCell("already there 2", destination.stage, destination.projectId);
        yield* tasks.update({ id: mover.id, ...patch });
        return {
          origin: yield* readCellTitles(project, "planned"),
          destination: yield* readCellTitles(destination.projectId, destination.stage),
        };
      }),
    );
    expect(result.origin).toEqual(["stays"]);
    expect(result.destination).toEqual(["already there 1", "already there 2", "mover"]);
  });

  it("keeps the place of a Task whose update changes neither its stage nor its project", async () => {
    const before = await run(
      Effect.gen(function* () {
        const repository = yield* taskRepository;
        const tasks = yield* TaskService;
        const first = yield* createInCell("first", "planned");
        yield* createInCell("second", "planned");
        const ranks = yield* repository.listCellRanks({ projectId: null, stage: "planned" });
        yield* tasks.update({ id: first.id, title: "renamed", priority: "high" });
        const after = yield* repository.listCellRanks({ projectId: null, stage: "planned" });
        return { ranks, after };
      }),
    );
    expect(before.after).toEqual(before.ranks);
  });

  it("spreads a cell again, keeping its order, when the last rank is too long to go after", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repository = yield* taskRepository;
        const first = yield* createInCell("first", "planned");
        yield* createInCell("second", "planned");
        const last = "z".repeat(MAX_BOARD_RANK_LENGTH);
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            yield* sql`UPDATE tasks SET board_rank = ${last} WHERE id = ${uuidFromString(first.id)}`;
            yield* sql`UPDATE tasks SET board_rank = ${"zzz"} WHERE title = 'second'`;
          }),
        );
        // "first" now sorts after "second", at the longest rank there is.
        yield* createInCell("third", "planned");
        return {
          titles: yield* readCellTitles(null, "planned"),
          ranks: yield* repository.listCellRanks({ projectId: null, stage: "planned" }),
        };
      }),
    );
    expect(result.titles).toEqual(["second", "first", "third"]);
    expect(result.ranks.every((entry) => entry.boardRank.length < MAX_BOARD_RANK_LENGTH)).toBe(
      true,
    );
  });

  it("puts the Task a new Thread gets last in its cell", async () => {
    const titles = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        yield* createInCell("existing", "exploring");
        yield* tasks.joinSession({
          requestedTaskId: undefined,
          callerTaskId: undefined,
          workspaceId: null,
          sessionKind: "thread",
          title: "A new thread",
          projectId: undefined,
        });
        return yield* readCellTitles(null, "exploring");
      }),
    );
    expect(titles).toEqual(["existing", "A new thread"]);
  });
});

const RUN_A = "0199e0e7-0a01-7000-8000-000000000001";
const RUN_B = "0199e0e7-0a01-7000-8000-000000000002";
const RUN_C = "0199e0e7-0a01-7000-8000-000000000003";

/** Returns the failure state of a Task as the repository stores it. */
const readState = (taskId: string) =>
  Effect.gen(function* () {
    const repository = yield* taskRepository;
    const state = yield* repository.readFailureState(taskId);
    return state._tag === "Some" ? state.value : undefined;
  });

/** Creates a Task that shows the failure of `RUN_A`. */
const createFailedTask = Effect.gen(function* () {
  const tasks = yield* TaskService;
  const task = yield* createInCell("Refund button", "building");
  yield* tasks.recordRunFailure({ taskId: task.id, runId: RUN_A });
  return task;
});

describe("the failure a Task shows", () => {
  it("is set by a failing run, and a drag, a stage change and an edit leave it", async () => {
    const state = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* createFailedTask;
        yield* tasks.update({ id: task.id, stage: "in-review" });
        yield* tasks.update({ id: task.id, stage: "landed" });
        yield* tasks.update({ id: task.id, title: "Add a refund button" });
        return yield* readState(task.id);
      }),
    );
    expect(state).toMatchObject({ failedRunId: RUN_A, stage: "landed", deleted: false });
  });

  it("is ended by a run that starts on the Task, which leaves one row to restore it from", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const repository = yield* taskRepository;
        const task = yield* createFailedTask;
        const failing = yield* readState(task.id);
        yield* tasks.recordRunStart({ taskId: task.id, runId: RUN_B });
        yield* tasks.recordRunStart({ taskId: task.id, runId: RUN_C });
        return {
          failing,
          after: yield* readState(task.id),
          first: yield* repository.readFailureRecovery(RUN_B),
          second: yield* repository.readFailureRecovery(RUN_C),
        };
      }),
    );
    expect(result.after?.failedRunId).toBeUndefined();
    // Failure set, then two starts: the revision rose three times.
    expect(result.after!.failureRevision).toBe(result.failing!.failureRevision + 2);
    expect(result.first).toMatchObject({
      _tag: "Some",
      value: { failedRunId: RUN_A, restoredAt: undefined },
    });
    expect(result.second._tag).toBe("None");
  });

  it("raises the revision for a start on a Task that shows no failure, and does nothing for a Task not written yet", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* createInCell("Plain", "planned");
        const before = yield* readState(task.id);
        yield* tasks.recordRunStart({ taskId: task.id, runId: RUN_B });
        yield* tasks.recordRunStart({
          taskId: "0199e0e7-0a01-7000-8000-0000000000ff",
          runId: RUN_C,
        });
        return { before, after: yield* readState(task.id) };
      }),
    );
    expect(result.after!.failureRevision).toBe(result.before!.failureRevision + 1);
  });

  it("is brought back by the restore of the start that ended it, once", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* createFailedTask;
        yield* tasks.recordRunStart({ taskId: task.id, runId: RUN_B });
        const restored = yield* tasks.restoreRecoveredFailure({ runId: RUN_B });
        const state = yield* readState(task.id);
        const again = yield* tasks.restoreRecoveredFailure({ runId: RUN_B });
        return { task, restored, state, again };
      }),
    );
    expect(result.restored).toEqual({ restored: true, taskId: result.task.id });
    expect(result.state?.failedRunId).toBe(RUN_A);
    expect(result.again).toEqual({ restored: false, reason: "already-restored" });
  });

  it("is not restored for a run start that ended no failure", async () => {
    const restoration = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* createInCell("Plain", "planned");
        yield* tasks.recordRunStart({ taskId: task.id, runId: RUN_B });
        return yield* tasks.restoreRecoveredFailure({ runId: RUN_B });
      }),
    );
    expect(restoration).toEqual({ restored: false, reason: "no-such-start" });
  });

  it.each([
    [
      "a newer failure",
      "handled-since",
      (taskId: string) =>
        Effect.flatMap(TaskService, (tasks) => tasks.recordRunFailure({ taskId, runId: RUN_C })),
    ],
    [
      "a newer run start",
      "handled-since",
      (taskId: string) =>
        Effect.flatMap(TaskService, (tasks) => tasks.recordRunStart({ taskId, runId: RUN_C })),
    ],
    [
      "Done",
      "task-finished",
      (taskId: string) =>
        Effect.flatMap(TaskService, (tasks) => tasks.update({ id: taskId, stage: "done" })),
    ],
    [
      "Drop",
      "task-finished",
      (taskId: string) =>
        Effect.flatMap(TaskService, (tasks) => tasks.update({ id: taskId, stage: "dropped" })),
    ],
    [
      "a delete",
      "task-deleted",
      (taskId: string) => Effect.flatMap(TaskService, (tasks) => tasks.delete(taskId)),
    ],
  ] as const)(
    "is not brought back after %s, and nothing is overwritten",
    async (_name, reason, interfere) => {
      const result = await run(
        Effect.gen(function* () {
          const tasks = yield* TaskService;
          const task = yield* createFailedTask;
          yield* tasks.recordRunStart({ taskId: task.id, runId: RUN_B });
          yield* interfere(task.id);
          const before = yield* readState(task.id);
          const restoration = yield* tasks.restoreRecoveredFailure({ runId: RUN_B });
          return { before, restoration, after: yield* readState(task.id) };
        }),
      );
      expect(result.restoration).toEqual({ restored: false, reason });
      expect(result.after).toEqual(result.before);
    },
  );

  it("stays stored through Done, so an Undo of Done shows the card failed again", async () => {
    const states = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* createFailedTask;
        yield* tasks.update({ id: task.id, stage: "done" });
        const done = yield* readState(task.id);
        yield* tasks.update({ id: task.id, stage: "building" });
        return { done, reopened: yield* readState(task.id) };
      }),
    );
    expect(states.done?.failedRunId).toBe(RUN_A);
    expect(states.reopened?.failedRunId).toBe(RUN_A);
    expect(states.reopened!.failureRevision).toBeGreaterThan(0);
  });
});
