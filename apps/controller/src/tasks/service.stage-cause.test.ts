/**
 * Tests the cause a card shows for its stage, through the Task service and
 * the board and detail reads on real rows: a fact that moves a card sets it
 * with the thing's own words, any other write of the stage clears it, and it
 * outlives an unlink of the thing.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import { CurrentActor } from "../actor";
import { withTransaction } from "../db";
import { TaskBoardFactsLayer, TaskDetailFactsLayer, TaskServicePortsLayer } from "../daemon/tasks";
import { TaskTrackingRunsLayer } from "../daemon/runs";
import { PlatformEventsLayer } from "../events";
import { NotifierLayer } from "../notifications";
import { buildPluginStack } from "../plugins/testing";
import { TaskBoard, TaskBoardLayer } from "./board";
import { TaskDetails, TaskDetailsLayer } from "./detail";
import { TaskService, TaskServiceLayer } from "./index";
import { A_MINUTE, arrange, arrangeConnection, createTaskLinking, pr, USER } from "./testing";

const reads = Layer.mergeAll(TaskBoardLayer, TaskDetailsLayer).pipe(
  Layer.provide(Layer.mergeAll(TaskBoardFactsLayer, TaskTrackingRunsLayer, TaskDetailFactsLayer)),
  Layer.provideMerge(buildPluginStack()),
);

const TestLayer = TaskServiceLayer.pipe(
  Layer.provideMerge(NotifierLayer),
  Layer.provideMerge(TaskServicePortsLayer),
  Layer.provideMerge(PlatformEventsLayer),
  Layer.provideMerge(reads),
);

const run = <A, E>(
  effect: Effect.Effect<A, E, TaskService | TaskBoard | TaskDetails | SqlClient.SqlClient>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(CurrentActor, USER),
      Effect.provide(TestLayer),
      Effect.provide(TestClock.layer()),
    ),
  );

/** Reads the stage cause of the card of the Task on the board, or undefined. */
const readBoardCause = (taskId: string) =>
  Effect.gen(function* () {
    const board = yield* Effect.flatMap(TaskBoard, (reader) => reader.query());
    return board.cards.find((card) => card.id === taskId)?.stageCause;
  });

/** Sends the stage write a workflow sends when a fact arrives. */
const landByFact = (taskId: string, factId: number) =>
  Effect.gen(function* () {
    yield* TestClock.adjust(A_MINUTE);
    const tasks = yield* TaskService;
    return yield* tasks.update({ id: taskId, stage: "landed", stageFactId: factId });
  });

const MERGED = {
  ref: pr(6221),
  lifecycle: "completed",
  identifier: "#6221",
  statusLabel: "Merged",
} as const;

describe("the cause of a card's stage", () => {
  it("shows the fact that moved the card, in the thing's own words, on the board and in the detail", async () => {
    const { board, detail } = await run(
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange(MERGED);
        const task = yield* createTaskLinking("Refund button", pr(6221)); // fact 1
        yield* landByFact(task.id, 1);
        const details = yield* TaskDetails;
        return {
          board: yield* readBoardCause(task.id),
          detail: (yield* details.read(task.id)).card.stageCause,
        };
      }),
    );
    const expected = { factId: 1, ref: pr(6221), text: "Pull request #6221 merged" };
    expect(board).toEqual(expected);
    expect(detail).toEqual(expected);
  });

  it.each([
    [
      "a drag to another stage",
      (id: string) => Effect.flatMap(TaskService, (tasks) => tasks.move({ id, stage: "building" })),
    ],
    [
      "an edit of the stage",
      (id: string) => Effect.flatMap(TaskService, (tasks) => tasks.update({ id, stage: "landed" })),
    ],
    [
      "a legacy status write that moves the stage",
      (id: string) => Effect.flatMap(TaskService, (tasks) => tasks.update({ id, status: "open" })),
    ],
  ])("is gone after %s", async (_name, write) => {
    const cause = await run(
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange(MERGED);
        const task = yield* createTaskLinking("Refund button", pr(6221));
        yield* landByFact(task.id, 1);
        yield* TestClock.adjust(A_MINUTE);
        yield* write(task.id);
        return yield* readBoardCause(task.id);
      }),
    );
    expect(cause).toBeUndefined();
  });

  it("stays after a reorder inside the column, which decides nothing about the stage", async () => {
    const cause = await run(
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange(MERGED);
        const task = yield* createTaskLinking("Refund button", pr(6221));
        yield* landByFact(task.id, 1);
        yield* TestClock.adjust(A_MINUTE);
        const tasks = yield* TaskService;
        yield* tasks.move({ id: task.id, afterTaskId: null });
        return yield* readBoardCause(task.id);
      }),
    );
    expect(cause?.factId).toBe(1);
  });

  it("stays after the thing is unlinked, because it is the history of why the card is there", async () => {
    const cause = await run(
      Effect.gen(function* () {
        yield* arrangeConnection;
        yield* arrange(MERGED);
        const task = yield* createTaskLinking("Refund button", pr(6221));
        yield* landByFact(task.id, 1);
        yield* TestClock.adjust(A_MINUTE);
        const tasks = yield* TaskService;
        yield* tasks.unlinkEntity({ id: task.id, ref: pr(6221) });
        return yield* readBoardCause(task.id);
      }),
    );
    expect(cause).toEqual({ factId: 1, ref: pr(6221), text: "Pull request #6221 merged" });
  });

  it("names a thing whose record is gone", async () => {
    const cause = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* arrangeConnection;
        yield* arrange(MERGED);
        const task = yield* createTaskLinking("Refund button", pr(6221));
        yield* landByFact(task.id, 1);
        yield* withTransaction(sql, sql`DELETE FROM external_entities WHERE ref = ${pr(6221)}`);
        return yield* readBoardCause(task.id);
      }),
    );
    expect(cause?.text).toBe("A linked thing completed");
  });

  it("is absent from a card no fact placed", async () => {
    const cause = await run(
      Effect.gen(function* () {
        yield* arrangeConnection;
        const task = yield* createTaskLinking("Plain card");
        return yield* readBoardCause(task.id);
      }),
    );
    expect(cause).toBeUndefined();
  });
});
