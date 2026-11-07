/**
 * Tests the bookkeeping behind Task Summaries, through `TaskService` on real
 * rows and a clock the tests move:
 *
 * - what marks a Task dirty, and what stops it being dirty;
 * - which Tasks the writer may claim, and how often;
 * - what the write of a finished attempt does, and does not do;
 * - the wake that tells the writer something is dirty.
 *
 * The board's reply that carries the summary is tested in `board.test.ts`,
 * and what marks a Task dirty from the sessions and runs domains in their own
 * integration tests.
 */
import { describe, expect, it } from "vitest";
import { Clock, Duration, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as Statement from "effect/sql/Statement";
import * as SqlClient from "effect/sql/SqlClient";
import { MAX_SUMMARY_LINE, type TaskStage } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { AfterCommit, uuidFromString, withTransaction, type Change } from "../db";
import { TestDatabase } from "../db/testing";
import { AuditLogLayer, PlatformEventsLayer } from "../events";
import { readEventsOfKind } from "../events/testing";
import { NotifierLayer } from "../notifications";
import { taskRepository } from "./repository";
import {
  SUMMARY_MIN_INTERVAL_SECONDS,
  SUMMARY_QUIET_SECONDS,
  TaskService,
  TaskServiceLayer,
  TaskSummaryWake,
  makeSummaryWake,
} from "./index";
import { TaskLinkOwnersLayer } from "../daemon/tasks";

const layer = TaskServiceLayer.pipe(
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
  effect: Effect.Effect<A, E, TaskService | SqlClient.SqlClient>,
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

/** Claims what is due, then returns the claimed Task ids. */
const claim = (limit = 10) =>
  Effect.flatMap(TaskService, (tasks) =>
    Effect.map(tasks.claimSummaryAttempts({ limit }), (attempts) =>
      attempts.map((attempt) => attempt.taskId),
    ),
  );

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
        const early = yield* claim();
        yield* wait(10);
        yield* tasks.markSummaryDirty(task.id);
        const due = yield* claim();
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
        const claimed = yield* claim();
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

describe("the Tasks the writer claims", () => {
  it("claims the oldest change first, at most the limit, once the Task has been quiet", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const first = yield* createTask("first");
        const second = yield* createTask("second");
        const third = yield* createTask("third");
        yield* tasks.markSummaryDirty(second.id);
        yield* wait(1);
        yield* tasks.markSummaryDirty(first.id);
        yield* wait(1);
        yield* tasks.markSummaryDirty(third.id);
        const tooSoon = yield* claim();
        yield* wait(SUMMARY_QUIET_SECONDS);
        const attempts = yield* tasks.claimSummaryAttempts({ limit: 2 });
        const rest = yield* claim();
        return { first, second, third, tooSoon, attempts, rest };
      }),
    );
    expect(result.tooSoon).toEqual([]);
    expect(result.attempts).toEqual([
      { taskId: result.second.id, dirtyRevision: 1 },
      { taskId: result.first.id, dirtyRevision: 1 },
    ]);
    expect(result.rest).toEqual([result.third.id]);
  });

  it("calls for a Task at most once in the minimum interval, however often it changes", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* createTask("Add a refund button");
        yield* makeDue(task.id);
        const first = yield* claim();
        const claimed = yield* readRow(task.id);
        yield* tasks.markSummaryDirty(task.id);
        yield* wait(SUMMARY_MIN_INTERVAL_SECONDS - 1);
        const early = yield* claim();
        yield* wait(1);
        const due = yield* claim();
        return { task, first, claimed, early, due };
      }),
    );
    expect(result.first).toEqual([result.task.id]);
    expect(result.claimed?.next_attempt_at).toBe(
      new Date((SUMMARY_QUIET_SECONDS + SUMMARY_MIN_INTERVAL_SECONDS) * 1000).toISOString(),
    );
    expect(result.early).toEqual([]);
    expect(result.due).toEqual([result.task.id]);
  });

  it.each([
    [
      "finished",
      (id: string) => Effect.flatMap(TaskService, (tasks) => tasks.update({ id, stage: "done" })),
    ],
    ["deleted", (id: string) => Effect.flatMap(TaskService, (tasks) => tasks.delete(id))],
    [
      "merged",
      (id: string) =>
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          withTransaction(
            sql,
            sql`UPDATE tasks SET merged_into_id = ${uuidFromString("0199e0e7-0004-7000-8000-000000000009")}
                WHERE id = ${uuidFromString(id)}`,
          ),
        ),
    ],
  ])("never claims a Task that is %s, even one still marked dirty", async (_name, end) => {
    const claimed = await run(
      Effect.gen(function* () {
        const task = yield* createTask("Add a refund button");
        yield* makeDue(task.id);
        yield* end(task.id);
        // A merge does not clear the mark itself; the claim must not depend on it.
        yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
          withTransaction(
            sql,
            sql`UPDATE task_summaries SET dirty_at = '1970-01-01T00:00:00.000Z'
                WHERE task_id = ${uuidFromString(task.id)}`,
          ),
        );
        return yield* claim();
      }),
    );
    expect(claimed).toEqual([]);
  });

  it("reads the due Tasks from the index of dirty rows, in its own order", async () => {
    const plan = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tasks = yield* taskRepository;
        const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
        yield* withTransaction(
          sql,
          tasks
            .claimSummaryAttempts({
              limit: 2,
              at: "2026-11-07T10:00:00.000Z",
              quietBefore: "2026-11-07T09:59:30.000Z",
              nextAttemptAt: "2026-11-07T10:05:00.000Z",
            })
            .pipe(
              Effect.provideService(Statement.CurrentTransformer, (statement) =>
                Effect.sync(() => {
                  statements.push(statement.compile());
                  return statement;
                }),
              ),
            ),
        );
        const [text, params] = statements[0]!;
        const rows = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${text}`,
          params,
        );
        return rows.map((row) => row.detail);
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );
    expect(plan.join("\n")).toContain("USING INDEX task_summaries_dirty");
    expect(plan.some((step) => step.includes("TEMP B-TREE"))).toBe(false);
  });
});

describe("a finished attempt", () => {
  it("is written once, makes the row current, and changes nothing else about the Task", async () => {
    const published: Array<Change> = [];
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* createTask("Add a refund button");
        yield* makeDue(task.id);
        const [attempt] = yield* tasks.claimSummaryAttempts({ limit: 1 });
        published.length = 0;
        const before = yield* tasks.read(task.id);
        const updatedEvents = (yield* readEventsOfKind("task.updated")).length;
        yield* wait(5);
        const written = yield* tasks.completeSummary({
          taskId: task.id,
          dirtyRevision: attempt!.dirtyRevision,
          summary: SUMMARY,
        });
        return {
          written,
          row: yield* readRow(task.id),
          before,
          after: yield* tasks.read(task.id),
          updatedEvents,
          updatedEventsAfter: (yield* readEventsOfKind("task.updated")).length,
          summarized: yield* readEventsOfKind("task.summarized"),
          taskId: task.id,
        };
      }),
      published,
    );
    expect(result.written).toBe(true);
    expect(result.row).toMatchObject({
      line: SUMMARY.line,
      dirty_at: null,
      dirty_revision: 1,
      input_revision: 1,
      attempt_count: 0,
      failed_at: null,
    });
    expect(result.after).toEqual(result.before);
    expect(result.updatedEventsAfter).toBe(result.updatedEvents);
    expect(result.summarized).toHaveLength(1);
    expect(result.summarized[0]).toMatchObject({
      actor: "system",
      payload: { taskId: result.taskId, dirtyRevision: 1 },
    });
    expect(published.filter((change) => change._tag === "record")).toEqual([
      { _tag: "record", topic: "task", id: result.taskId, kind: "updated", derived: true },
    ]);
  });

  it("is dropped when the Task changed while the writer worked, and the row stays dirty", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* createTask("Add a refund button");
        yield* makeDue(task.id);
        const [attempt] = yield* tasks.claimSummaryAttempts({ limit: 1 });
        yield* tasks.markSummaryDirty(task.id);
        const written = yield* tasks.completeSummary({
          taskId: task.id,
          dirtyRevision: attempt!.dirtyRevision,
          summary: SUMMARY,
        });
        const failed = yield* tasks.failSummary({
          taskId: task.id,
          dirtyRevision: attempt!.dirtyRevision,
          reason: "late",
        });
        return {
          written,
          failed,
          row: yield* readRow(task.id),
          summarized: yield* readEventsOfKind("task.summarized"),
        };
      }),
    );
    expect(result.written).toBe(false);
    expect(result.failed).toBe(false);
    expect(result.row).toMatchObject({
      line: null,
      dirty_revision: 2,
      attempt_count: 0,
      failed_at: null,
    });
    expect(result.row?.dirty_at).not.toBeNull();
    expect(result.summarized).toEqual([]);
  });

  it.each([
    [
      "finished",
      (id: string) =>
        Effect.flatMap(TaskService, (tasks) => tasks.update({ id, stage: "dropped" })),
    ],
    ["deleted", (id: string) => Effect.flatMap(TaskService, (tasks) => tasks.delete(id))],
  ])("is dropped, answer or failure, when the Task is %s meanwhile", async (_name, end) => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* createTask("Add a refund button");
        yield* makeDue(task.id);
        const [attempt] = yield* tasks.claimSummaryAttempts({ limit: 1 });
        yield* end(task.id);
        const input = { taskId: task.id, dirtyRevision: attempt!.dirtyRevision };
        return {
          written: yield* tasks.completeSummary({ ...input, summary: SUMMARY }),
          failed: yield* tasks.failSummary({ ...input, reason: "late" }),
          row: yield* readRow(task.id),
        };
      }),
    );
    expect(result.written).toBe(false);
    expect(result.failed).toBe(false);
    expect(result.row).toMatchObject({ line: null, attempt_count: 0, failed_at: null });
  });

  it("makes no row for a Task that has none, so a late write cannot recreate a deleted one", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* createTask("Add a refund button");
        return {
          written: yield* tasks.completeSummary({
            taskId: task.id,
            dirtyRevision: 1,
            summary: SUMMARY,
          }),
          failed: yield* tasks.failSummary({ taskId: task.id, dirtyRevision: 1, reason: "late" }),
          row: yield* readRow(task.id),
        };
      }),
    );
    expect(result).toEqual({ written: false, failed: false, row: undefined });
  });

  it("refuses a line longer than the contract allows, which would fail every read of the board", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* createTask("Add a refund button");
        yield* makeDue(task.id);
        const [attempt] = yield* tasks.claimSummaryAttempts({ limit: 1 });
        return yield* Effect.exit(
          tasks.completeSummary({
            taskId: task.id,
            dirtyRevision: attempt!.dirtyRevision,
            summary: { ...SUMMARY, line: "x".repeat(MAX_SUMMARY_LINE + 1) },
          }),
        );
      }),
    );
    expect(outcome._tag).toBe("Failure");
  });
});

describe("a failed attempt", () => {
  it("keeps the last summary, shows the Task as dirty, and waits twice as long each time, up to an hour", async () => {
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* createTask("Add a refund button");
        yield* makeDue(task.id);
        const [first] = yield* tasks.claimSummaryAttempts({ limit: 1 });
        yield* tasks.completeSummary({
          taskId: task.id,
          dirtyRevision: first!.dirtyRevision,
          summary: SUMMARY,
        });
        yield* makeDue(task.id);
        // The pacing of the first attempt must pass before the next claim.
        yield* wait(SUMMARY_MIN_INTERVAL_SECONDS);
        const waits: Array<number> = [];
        for (let failure = 1; failure <= 6; failure += 1) {
          const [attempt] = yield* tasks.claimSummaryAttempts({ limit: 1 });
          const recorded = yield* tasks.failSummary({
            taskId: task.id,
            dirtyRevision: attempt!.dirtyRevision,
            reason: `provider said no ${String(failure)}`,
          });
          expect(recorded).toBe(true);
          const row = yield* readRow(task.id);
          const now = yield* Clock.currentTimeMillis;
          waits.push((Date.parse(row!.next_attempt_at!) - now) / 1000);
          yield* wait(waits.at(-1)!);
        }
        return { waits, lastRow: yield* readRow(task.id) };
      }),
    );
    expect(result.waits).toEqual([600, 1200, 2400, 3600, 3600, 3600]);
    expect(result.lastRow).toMatchObject({
      line: SUMMARY.line,
      attempt_count: 6,
      failed_reason: "provider said no 6",
    });
    expect(result.lastRow?.dirty_at).not.toBeNull();
    expect(result.lastRow?.failed_at).not.toBeNull();
  });

  it("starts the count again after a success", async () => {
    const row = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* createTask("Add a refund button");
        yield* makeDue(task.id);
        const [failing] = yield* tasks.claimSummaryAttempts({ limit: 1 });
        yield* tasks.failSummary({
          taskId: task.id,
          dirtyRevision: failing!.dirtyRevision,
          reason: "no",
        });
        yield* wait(3600);
        const [retry] = yield* tasks.claimSummaryAttempts({ limit: 1 });
        yield* tasks.completeSummary({
          taskId: task.id,
          dirtyRevision: retry!.dirtyRevision,
          summary: SUMMARY,
        });
        return yield* readRow(task.id);
      }),
    );
    expect(row).toMatchObject({ attempt_count: 0, failed_at: null, failed_reason: null });
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
