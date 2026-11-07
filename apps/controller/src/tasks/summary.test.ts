/**
 * Tests the bookkeeping behind Task Summaries, through `TaskService` on real
 * rows and a clock the tests move:
 *
 * - what marks a Task dirty, and what stops it being dirty;
 * - the wake that tells the writer something is dirty.
 *
 * The board's reply that carries the summary is tested in `board.test.ts`,
 * and what marks a Task dirty from the sessions and runs domains in their own
 * integration tests.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import type { TaskStage } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { AfterCommit, uuidFromString, withTransaction, type Change } from "../db";
import { TestDatabase } from "../db/testing";
import { AuditLogLayer, PlatformEventsLayer } from "../events";
import { NotifierLayer } from "../notifications";
import { ServingPromotionStateLayer } from "../promotion/testing";
import {
  SUMMARY_QUIET_SECONDS,
  TaskService,
  TaskServiceLayer,
  TaskSummaries,
  TaskSummariesLayer,
  TaskSummaryWake,
  makeSummaryWake,
} from "./index";
import { TaskLinkOwnersLayer } from "../daemon/tasks";

const layer = Layer.mergeAll(TaskServiceLayer, TaskSummariesLayer).pipe(
  Layer.provideMerge(ServingPromotionStateLayer),
  Layer.provideMerge(NotifierLayer),
  Layer.provideMerge(TaskLinkOwnersLayer),
  Layer.provideMerge(Layer.mergeAll(AuditLogLayer, PlatformEventsLayer)),
  Layer.provideMerge(TestDatabase),
);

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

/**
 * Runs `effect` on a fresh database with a clock that starts at the epoch and
 * moves only when the test moves it. Every change a committed transaction
 * announces is added to `published`.
 */
const run = <A, E>(
  effect: Effect.Effect<A, E, TaskService | TaskSummaries | SqlClient.SqlClient>,
  published: Array<Change> = [],
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(CurrentActor, USER),
      Effect.provide(
        Layer.mergeAll(
          layer,
          Layer.succeed(AfterCommit)({
            publish: (changes) =>
              Effect.sync(() => {
                published.push(...changes);
              }),
          }),
        ),
      ),
      Effect.provide(TestClock.layer()),
    ),
  );

const SUMMARY = { line: "Refund bug found", standing: "The gift card path fails.", left: "A fix." };

/** The stored row of a Task's summary, or undefined when it has none. */
const readRow = (taskId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly line: string | null;
      readonly dirty_revision: number;
      readonly input_revision: number;
      readonly dirty_at: string | null;
      readonly next_attempt_at: string | null;
      readonly attempt_count: number;
      readonly failed_at: string | null;
      readonly failed_reason: string | null;
    }>`SELECT line, dirty_revision, input_revision, dirty_at, next_attempt_at, attempt_count,
              failed_at, failed_reason
       FROM task_summaries WHERE task_id = ${uuidFromString(taskId)}`;
    return rows[0];
  });

const createTask = (title: string, stage: TaskStage = "building") =>
  Effect.flatMap(TaskService, (tasks) => tasks.create({ title, description: "", stage }));

/** Moves the clock forward. */
const wait = (seconds: number) => TestClock.adjust(Duration.seconds(seconds));

/** Writes what is due with a stand-in model that answers at once, and returns the Task ids it was asked about. */
const writeDue = Effect.gen(function* () {
  const summaries = yield* TaskSummaries;
  const described: Array<string> = [];
  yield* summaries.writeDue({
    canDescribe: Effect.succeed(true),
    describe: (taskId) => Effect.sync(() => (described.push(taskId), SUMMARY)),
  });
  return described;
});

/** Marks the Task dirty and lets the quiet time pass, so the writer may claim it. */
const makeDue = (taskId: string) =>
  Effect.gen(function* () {
    yield* (yield* TaskService).markSummaryDirty(taskId);
    yield* wait(SUMMARY_QUIET_SECONDS);
  });

describe("what marks a Task dirty", () => {
  const joinAs = (sessionKind: "thread" | "agent", requestedTaskId: string) =>
    Effect.flatMap(TaskService, (tasks) =>
      tasks.joinSession({
        requestedTaskId,
        callerTaskId: undefined,
        workspaceId: null,
        sessionKind,
        title: "A Thread",
        projectId: undefined,
      }),
    );

  it.each([
    [
      "a new title",
      (id: string) => Effect.flatMap(TaskService, (tasks) => tasks.update({ id, title: "New" })),
      1,
    ],
    [
      "a new description",
      (id: string) =>
        Effect.flatMap(TaskService, (tasks) => tasks.update({ id, description: "More words" })),
      1,
    ],
    ["a Thread joining it", (id: string) => joinAs("thread", id), 1],
    [
      "a Thread coming back to it",
      (id: string) =>
        Effect.flatMap(TaskService, (tasks) =>
          tasks.rejoinThread({
            currentTaskId: id,
            workspaceId: null,
            title: "A Thread",
            projectId: undefined,
            actor: "user",
          }),
        ),
      1,
    ],
    [
      "taking it back from Done",
      (id: string) =>
        Effect.flatMap(TaskService, (tasks) =>
          Effect.andThen(
            tasks.update({ id, stage: "done" }),
            tasks.update({ id, stage: "building" }),
          ),
        ),
      1,
    ],
    [
      "the same title again",
      (id: string) =>
        Effect.flatMap(TaskService, (tasks) => tasks.update({ id, title: "Add a refund button" })),
      0,
    ],
    [
      "a priority or a label",
      (id: string) =>
        Effect.flatMap(TaskService, (tasks) =>
          tasks.update({ id, priority: "high", addLabels: ["payments"] }),
        ),
      0,
    ],
    [
      "a move to another live stage",
      (id: string) =>
        Effect.flatMap(TaskService, (tasks) => tasks.update({ id, stage: "planned" })),
      0,
    ],
    ["an agent session joining it", (id: string) => joinAs("agent", id), 0],
  ])("is %s: the revision rises by %i", async (_name, change, rise) => {
    const row = await run(
      Effect.gen(function* () {
        const task = yield* createTask("Add a refund button");
        yield* change(task.id);
        return yield* readRow(task.id);
      }),
    );
    expect(row?.dirty_revision ?? 0).toBe(rise);
    expect(row !== undefined && row.dirty_at !== null).toBe(rise > 0);
  });

  it("counts the quiet time from the first change, and keeps the pacing of the model calls", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* createTask("Add a refund button");
        yield* tasks.markSummaryDirty(task.id);
        yield* wait(10);
        yield* tasks.markSummaryDirty(task.id);
        const second = yield* readRow(task.id);
        // A change every 10 seconds: 20 seconds after the first change, then 30.
        yield* wait(10);
        yield* tasks.markSummaryDirty(task.id);
        const early = yield* writeDue;
        yield* wait(10);
        yield* tasks.markSummaryDirty(task.id);
        const due = yield* writeDue;
        const claimed = yield* readRow(task.id);
        yield* tasks.markSummaryDirty(task.id);
        const changedAgain = yield* readRow(task.id);
        return { task, second, early, due, claimed, changedAgain };
      }),
    );
    expect(result.second?.dirty_revision).toBe(2);
    expect(result.second?.dirty_at).toBe("1970-01-01T00:00:00.000Z");
    expect(result.early).toEqual([]);
    expect(result.due).toEqual([result.task.id]);
    expect(result.changedAgain?.next_attempt_at).toBe(result.claimed?.next_attempt_at);
    expect(result.changedAgain?.dirty_revision).toBe(5);
  });
});

describe("the announcement of a summary going stale", () => {
  it("is made once, by the first mark after a summary was written, and not for a Task with no summary", async () => {
    const published: Array<Change> = [];
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const withSummary = yield* createTask("Add a refund button");
        const withoutSummary = yield* createTask("Fix the login redirect");
        yield* makeDue(withSummary.id);
        yield* writeDue;
        const staleAnnouncements = () =>
          published.filter(
            (change) =>
              change._tag === "record" && change.topic === "task" && change.id === withSummary.id,
          ).length;
        published.length = 0;
        yield* tasks.markSummaryDirty(withSummary.id);
        const afterFirst = staleAnnouncements();
        yield* tasks.markSummaryDirty(withSummary.id);
        yield* tasks.markSummaryDirty(withSummary.id);
        const afterLater = staleAnnouncements();
        published.length = 0;
        yield* tasks.markSummaryDirty(withoutSummary.id);
        yield* tasks.markSummaryDirty(withoutSummary.id);
        return { afterFirst, afterLater, unsummarized: published.length, id: withSummary.id };
      }),
      published,
    );
    expect(result).toMatchObject({ afterFirst: 1, afterLater: 1, unsummarized: 0 });
  });
});

describe("what stops a Task being dirty", () => {
  it.each([
    [
      "Done",
      (id: string) => Effect.flatMap(TaskService, (tasks) => tasks.update({ id, stage: "done" })),
    ],
    [
      "Drop",
      (id: string) =>
        Effect.flatMap(TaskService, (tasks) => tasks.update({ id, stage: "dropped" })),
    ],
    ["a delete", (id: string) => Effect.flatMap(TaskService, (tasks) => tasks.delete(id))],
  ])("is %s: no summary is waiting, and a later change marks nothing", async (_name, end) => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* createTask("Add a refund button");
        yield* makeDue(task.id);
        yield* end(task.id);
        const afterEnd = yield* readRow(task.id);
        const claimed = yield* writeDue;
        yield* tasks.markSummaryDirty(task.id);
        return { afterEnd, claimed, afterMark: yield* readRow(task.id) };
      }),
    );
    expect(result.afterEnd?.dirty_at).toBeNull();
    expect(result.claimed).toEqual([]);
    expect(result.afterMark).toEqual(result.afterEnd);
  });

  it("makes a Task dirty again when it is taken back to a live stage", async () => {
    const row = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* createTask("Add a refund button");
        yield* makeDue(task.id);
        yield* tasks.update({ id: task.id, stage: "done" });
        yield* tasks.move({ id: task.id, stage: "in-review" });
        return yield* readRow(task.id);
      }),
    );
    expect(row?.dirty_at).not.toBeNull();
    expect(row?.dirty_revision).toBe(2);
  });
});

describe("the wake of the summary writer", () => {
  /** Counts the wakes, in place of the process-wide wake. */
  const countWakes = () => {
    const wakes = { count: 0 };
    return { wakes, wake: { wake: () => void (wakes.count += 1), awaitWake: () => Effect.void } };
  };

  it("fires once after the commit of a change that marked a Task, and never for a rolled-back one or a finished Task", async () => {
    const { wakes, wake } = countWakes();
    const counts = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const sql = yield* SqlClient.SqlClient;
        const task = yield* createTask("Add a refund button");
        const finished = yield* createTask("Done already", "done");
        yield* tasks.markSummaryDirty(finished.id);
        const forFinished = wakes.count;
        yield* Effect.exit(
          withTransaction(
            sql,
            Effect.andThen(tasks.markSummaryDirty(task.id), Effect.fail("rolled back")),
          ),
        );
        const afterRollback = wakes.count;
        const inside: Array<number> = [];
        yield* withTransaction(
          sql,
          Effect.andThen(
            tasks.markSummaryDirty(task.id),
            Effect.sync(() => inside.push(wakes.count)),
          ),
        );
        return { forFinished, afterRollback, inside, afterCommit: wakes.count };
      }).pipe(Effect.provideService(TaskSummaryWake, wake)),
    );
    expect(counts).toEqual({ forFinished: 0, afterRollback: 0, inside: [0], afterCommit: 1 });
  });

  it("lets the writer wait for a wake, or the backstop, and keeps a wake that came while it worked", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const wake = makeSummaryWake();
        const state = { woken: false, backstopped: false };
        const waiting = yield* Effect.forkChild(
          Effect.andThen(
            wake.awaitWake(Duration.minutes(1)),
            Effect.sync(() => void (state.woken = true)),
          ),
        );
        yield* TestClock.adjust(Duration.seconds(59));
        const stillWaiting = !state.woken;
        yield* TestClock.adjust(Duration.seconds(1));
        yield* Fiber.join(waiting);
        const afterBackstop = state.woken;
        // A wake while nobody waits is kept for the next wait.
        wake.wake();
        yield* wake.awaitWake(Duration.minutes(1));
        return { stillWaiting, afterBackstop };
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(result).toEqual({ stillWaiting: true, afterBackstop: true });
  });
});
