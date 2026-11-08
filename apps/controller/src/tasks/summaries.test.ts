/**
 * Tests the rules for writing Task Summaries, through `TaskSummaries.writeDue`
 * on real rows, with a clock the tests move and a stand-in describer (the
 * edge of the system: the model):
 *
 * - which Tasks are due, how many are written at once, and when the next is due;
 * - how often a Task may be tried, and how long a failure waits;
 * - what happens to an answer or a failure that arrives after the Task changed
 *   or ended;
 * - that one Task's trouble does not stop the Task beside it.
 *
 * What marks a Task dirty is tested in `summary.test.ts`, the loop that calls
 * `writeDue` in `daemon/tasks/summary-writer.test.ts`, and the model call and
 * the parsing of its answer in `daemon/tasks/summary-input.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Clock, Deferred, Duration, Effect, Fiber, Layer, Option } from "effect";
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
import { ServingPromotionStateLayer } from "../promotion/testing";
import { taskRepository } from "./repository";
import {
  SUMMARY_CONCURRENCY,
  SUMMARY_MIN_INTERVAL_SECONDS,
  SUMMARY_QUIET_SECONDS,
  TaskService,
  TaskServiceLayer,
  TaskSummaries,
  TaskSummariesLayer,
  makeSummaryWake,
  TaskSummaryWake,
  type SummaryText,
} from "./index";
import { TaskServicePortsLayer } from "../daemon/tasks";

const layer = Layer.mergeAll(TaskServiceLayer, TaskSummariesLayer).pipe(
  Layer.provideMerge(ServingPromotionStateLayer),
  Layer.provideMerge(NotifierLayer),
  Layer.provideMerge(TaskServicePortsLayer),
  Layer.provideMerge(Layer.mergeAll(AuditLogLayer, PlatformEventsLayer)),
  Layer.provideMerge(TestDatabase),
);

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

const SUMMARY: SummaryText = {
  line: "Refund bug found",
  standing: "The gift card path fails.",
  left: "A fix.",
};

type Services = TaskService | TaskSummaries | SqlClient.SqlClient;

/**
 * Runs `effect` on a fresh database with a clock that starts at the epoch and
 * moves only when the test moves it. Every change a committed transaction
 * announces is added to `published`.
 */
const run = <A, E>(effect: Effect.Effect<A, E, Services>, published: Array<Change> = []) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(CurrentActor, USER),
      Effect.provideService(TaskSummaryWake, makeSummaryWake()),
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

/** What a stand-in describer was asked, and what it answers next. A test changes `answer` between calls. */
interface StandInModel {
  /** The Task ids it was asked about, in order. */
  readonly asked: Array<string>;
  inFlight: number;
  mostInFlight: number;
  /** Whether `canDescribe` says yes. */
  available: boolean;
  /** How many times `canDescribe` was asked. */
  availabilityChecks: number;
  answer: (taskId: string) => Effect.Effect<SummaryText, string>;
}

const buildStandInModel = (): StandInModel => ({
  asked: [],
  inFlight: 0,
  mostInFlight: 0,
  available: true,
  availabilityChecks: 0,
  answer: () => Effect.succeed(SUMMARY),
});

/** Writes what is due with `model` and returns when the next Task is due. */
const writeDue = (model: StandInModel) =>
  Effect.flatMap(TaskSummaries, (summaries) =>
    summaries.writeDue({
      canDescribe: Effect.sync(() => {
        model.availabilityChecks += 1;
        return model.available;
      }),
      describe: (taskId) => {
        model.asked.push(taskId);
        model.inFlight += 1;
        model.mostInFlight = Math.max(model.mostInFlight, model.inFlight);
        return Effect.ensuring(
          model.answer(taskId),
          Effect.sync(() => {
            model.inFlight -= 1;
          }),
        );
      },
    }),
  );

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

const markDirty = (taskId: string) =>
  Effect.flatMap(TaskService, (tasks) => tasks.markSummaryDirty(taskId));

const wait = (seconds: number) => TestClock.adjust(Duration.seconds(seconds));

/** Marks the Task dirty and lets the quiet time pass, so the writer may take it. */
const makeDue = (taskId: string) => Effect.andThen(markDirty(taskId), wait(SUMMARY_QUIET_SECONDS));

/**
 * Returns a function that runs a task service call from inside a stand-in
 * model's answer, as the change that lands while the model works.
 */
const duringCall = Effect.map(
  Effect.context<TaskService>(),
  (services) =>
    <A, E>(effect: Effect.Effect<A, E, TaskService>) =>
      Effect.orDie(Effect.provide(effect, services)),
);

/** Lets the fibers the test forked run until they wait on something. */
const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true });

const at = (seconds: number) => new Date(seconds * 1000).toISOString();

const finishTask = (id: string) =>
  Effect.asVoid(Effect.flatMap(TaskService, (tasks) => tasks.update({ id, stage: "dropped" })));
const deleteTask = (id: string) =>
  Effect.asVoid(Effect.flatMap(TaskService, (tasks) => tasks.delete(id)));

describe("the Tasks that are written", () => {
  it("are the oldest change first, two at a time, once the Task has been quiet", async () => {
    const result = await run(
      Effect.gen(function* () {
        const model = buildStandInModel();
        const first = yield* createTask("first");
        const second = yield* createTask("second");
        const third = yield* createTask("third");
        yield* markDirty(second.id);
        yield* wait(1);
        yield* markDirty(first.id);
        yield* wait(1);
        yield* markDirty(third.id);
        const tooSoon = yield* writeDue(model);
        const askedTooSoon = model.asked.length;
        yield* wait(SUMMARY_QUIET_SECONDS);
        yield* writeDue(model);
        return { first, second, third, tooSoon, askedTooSoon, asked: model.asked };
      }),
    );
    expect(result.askedTooSoon).toBe(0);
    expect(result.tooSoon).toEqual(Option.some(at(SUMMARY_QUIET_SECONDS)));
    expect(result.asked).toEqual([result.second.id, result.first.id, result.third.id]);
  });

  it("are never more than two at once, and the whole backlog is drained", async () => {
    const result = await run(
      Effect.gen(function* () {
        const model = buildStandInModel();
        model.answer = () =>
          Effect.andThen(Effect.sleep(Duration.seconds(20)), Effect.succeed(SUMMARY));
        const ids = yield* Effect.forEach(["a", "b", "c", "d", "e"], (title) =>
          Effect.map(createTask(title), (task) => task.id),
        );
        yield* Effect.forEach(ids, markDirty);
        yield* wait(SUMMARY_QUIET_SECONDS);
        const writing = yield* Effect.forkChild(writeDue(model));
        yield* settle;
        yield* Effect.forEach(Array.from({ length: 10 }), () => Effect.andThen(wait(10), settle), {
          discard: true,
        });
        const next = yield* Fiber.join(writing);
        return {
          mostInFlight: model.mostInFlight,
          asked: model.asked.length,
          next,
          ids,
          rows: yield* Effect.forEach(ids, readRow),
        };
      }),
    );
    expect(SUMMARY_CONCURRENCY).toBe(2);
    expect(result.mostInFlight).toBe(2);
    expect(result.asked).toBe(5);
    expect(result.next).toEqual(Option.none());
    expect(result.rows.map((row) => row?.dirty_at)).toEqual([null, null, null, null, null]);
  });

  it.each([
    ["finished", finishTask],
    ["deleted", deleteTask],
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
  ])("never include a Task that is %s, even one still marked dirty", async (_name, end) => {
    const result = await run(
      Effect.gen(function* () {
        const model = buildStandInModel();
        const task = yield* createTask("Add a refund button");
        yield* makeDue(task.id);
        yield* end(task.id);
        // A merge does not clear the mark itself; the choice must not depend on it.
        yield* Effect.flatMap(SqlClient.SqlClient, (sql) =>
          withTransaction(
            sql,
            sql`UPDATE task_summaries SET dirty_at = '1970-01-01T00:00:00.000Z'
                WHERE task_id = ${uuidFromString(task.id)}`,
          ),
        );
        const next = yield* writeDue(model);
        return { next, asked: model.asked };
      }),
    );
    expect(result.asked).toEqual([]);
    expect(result.next).toEqual(Option.none());
  });

  it("are not written for a Task that ended before it was due", async () => {
    const asked = await run(
      Effect.gen(function* () {
        const model = buildStandInModel();
        const task = yield* createTask("Add a refund button");
        yield* markDirty(task.id);
        yield* wait(10);
        yield* finishTask(task.id);
        yield* wait(3600);
        yield* writeDue(model);
        return model.asked;
      }),
    );
    expect(asked).toEqual([]);
  });
});

describe("the time the next Task is due", () => {
  it("is none while no Task is dirty, and for a dirty Task that is finished", async () => {
    const result = await run(
      Effect.gen(function* () {
        const model = buildStandInModel();
        const task = yield* createTask("Add a refund button");
        const clean = yield* writeDue(model);
        yield* markDirty(task.id);
        yield* finishTask(task.id);
        return { clean, finished: yield* writeDue(model) };
      }),
    );
    expect(result).toEqual({ clean: Option.none(), finished: Option.none() });
  });

  it("is the quiet time after the first change, however many changes follow, and nothing is asked or claimed before it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const model = buildStandInModel();
        const task = yield* createTask("Add a refund button");
        yield* markDirty(task.id);
        yield* wait(10);
        yield* markDirty(task.id);
        return {
          dueAt: yield* writeDue(model),
          availabilityChecks: model.availabilityChecks,
          row: yield* readRow(task.id),
        };
      }),
    );
    expect(result.dueAt).toEqual(Option.some(at(SUMMARY_QUIET_SECONDS)));
    expect(result.availabilityChecks).toBe(0);
    expect(result.row?.next_attempt_at).toBeNull();
  });

  it("is the least over the dirty Tasks, and waits for the next attempt time when that is later", async () => {
    const result = await run(
      Effect.gen(function* () {
        const model = buildStandInModel();
        const first = yield* createTask("Add a refund button");
        yield* makeDue(first.id);
        // Writing paces the Task: its next attempt is five minutes away.
        yield* writeDue(model);
        yield* markDirty(first.id);
        const paced = yield* writeDue(model);
        yield* wait(10);
        const second = yield* createTask("Second");
        yield* markDirty(second.id);
        return { paced, withSecond: yield* writeDue(model), asked: model.asked.length };
      }),
    );
    expect(result.paced).toEqual(
      Option.some(at(SUMMARY_QUIET_SECONDS + SUMMARY_MIN_INTERVAL_SECONDS)),
    );
    expect(result.withSecond).toEqual(Option.some(at(SUMMARY_QUIET_SECONDS + 10 + 30)));
    expect(result.asked).toBe(1);
  });

  it("is a time that has already passed while no model can be used, and then no Task is claimed or tried", async () => {
    const result = await run(
      Effect.gen(function* () {
        const model = buildStandInModel();
        model.available = false;
        const task = yield* createTask("Add a refund button");
        yield* makeDue(task.id);
        const whileOff = yield* writeDue(model);
        const rowWhileOff = yield* readRow(task.id);
        model.available = true;
        yield* writeDue(model);
        return { whileOff, rowWhileOff, asked: model.asked, row: yield* readRow(task.id) };
      }),
    );
    expect(result.whileOff).toEqual(Option.some(at(SUMMARY_QUIET_SECONDS)));
    expect(result.rowWhileOff).toMatchObject({ next_attempt_at: null });
    expect(result.rowWhileOff?.dirty_at).not.toBeNull();
    expect(result.asked).toHaveLength(1);
    expect(result.row).toMatchObject({ line: SUMMARY.line, dirty_at: null });
  });
});

describe("the pacing of the calls", () => {
  it("calls for a Task at most once in the minimum interval, however often it changes", async () => {
    const result = await run(
      Effect.gen(function* () {
        const model = buildStandInModel();
        const task = yield* createTask("Add a refund button");
        yield* markDirty(task.id);
        yield* wait(10);
        yield* markDirty(task.id);
        yield* wait(10);
        yield* markDirty(task.id);
        const beforeQuiet = yield* writeDue(model);
        yield* wait(10);
        yield* writeDue(model);
        const written = yield* readRow(task.id);
        yield* markDirty(task.id);
        yield* wait(SUMMARY_MIN_INTERVAL_SECONDS - 1);
        yield* writeDue(model);
        const early = model.asked.length;
        yield* wait(1);
        yield* writeDue(model);
        return { task, beforeQuiet, written, early, asked: model.asked };
      }),
    );
    expect(result.beforeQuiet).toEqual(Option.some(at(SUMMARY_QUIET_SECONDS)));
    // Three changes made one call.
    expect(result.written).toMatchObject({ dirty_revision: 3, input_revision: 3, dirty_at: null });
    expect(result.written?.next_attempt_at).toBe(
      at(SUMMARY_QUIET_SECONDS + SUMMARY_MIN_INTERVAL_SECONDS),
    );
    expect(result.early).toBe(1);
    expect(result.asked).toEqual([result.task.id, result.task.id]);
  });

  it("repeats a call that a restart cut off, but only after the Task's next attempt time", async () => {
    const result = await run(
      Effect.gen(function* () {
        const model = buildStandInModel();
        model.answer = () => Effect.never;
        const task = yield* createTask("Add a refund button");
        yield* makeDue(task.id);
        const first = yield* Effect.forkChild(writeDue(model));
        yield* settle;
        yield* Fiber.interrupt(first);
        const cutOff = model.asked.length;
        model.answer = () => Effect.succeed(SUMMARY);
        yield* writeDue(model);
        const duringPacing = model.asked.length;
        yield* wait(SUMMARY_MIN_INTERVAL_SECONDS);
        yield* writeDue(model);
        return { cutOff, duringPacing, asked: model.asked.length, row: yield* readRow(task.id) };
      }),
    );
    expect(result).toMatchObject({ cutOff: 1, duringPacing: 1, asked: 2 });
    expect(result.row).toMatchObject({ line: SUMMARY.line, dirty_at: null });
  });
});

describe("a stored answer", () => {
  it("makes the row current, and changes nothing else about the Task", async () => {
    const published: Array<Change> = [];
    const result = await run(
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const model = buildStandInModel();
        const task = yield* createTask("Add a refund button");
        yield* makeDue(task.id);
        const before = yield* tasks.read(task.id);
        const updatedEvents = (yield* readEventsOfKind("task.updated")).length;
        published.length = 0;
        yield* writeDue(model);
        return {
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

  it("keeps an empty line as it is, so the card keeps its fallback", async () => {
    const row = await run(
      Effect.gen(function* () {
        const model = buildStandInModel();
        model.answer = () => Effect.succeed({ ...SUMMARY, line: "" });
        const task = yield* createTask("Add a refund button");
        yield* makeDue(task.id);
        yield* writeDue(model);
        return yield* readRow(task.id);
      }),
    );
    expect(row).toMatchObject({ line: "", dirty_at: null });
  });

  it("is refused when its line is longer than the contract allows, which would fail every read of the board", async () => {
    const result = await run(
      Effect.gen(function* () {
        const model = buildStandInModel();
        model.answer = () => Effect.succeed({ ...SUMMARY, line: "x".repeat(MAX_SUMMARY_LINE + 1) });
        const task = yield* createTask("Add a refund button");
        yield* makeDue(task.id);
        // The defect is logged and the Task keeps no summary; the call itself does not fail.
        const next = yield* writeDue(model);
        return { next, row: yield* readRow(task.id) };
      }),
    );
    expect(Option.isSome(result.next)).toBe(true);
    expect(result.row).toMatchObject({ line: null, attempt_count: 0 });
  });
});

describe("an answer that arrives after the Task changed", () => {
  it("is stored as a stale summary, the row stays dirty, and the next call, after the pacing, refreshes it", async () => {
    const published: Array<Change> = [];
    const result = await run(
      Effect.gen(function* () {
        const model = buildStandInModel();
        const gate = yield* Deferred.make<void>();
        model.answer = () => Effect.andThen(Deferred.await(gate), Effect.succeed(SUMMARY));
        const task = yield* createTask("Add a refund button");
        yield* makeDue(task.id);
        const writing = yield* Effect.forkChild(writeDue(model));
        yield* settle;
        const inFlight = model.inFlight;
        yield* markDirty(task.id);
        const before = yield* readRow(task.id);
        published.length = 0;
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(writing);
        const stale = yield* readRow(task.id);
        const summarized = yield* readEventsOfKind("task.summarized");
        yield* wait(SUMMARY_MIN_INTERVAL_SECONDS - 1);
        yield* writeDue(model);
        const askedDuringPacing = model.asked.length;
        model.answer = () => Effect.succeed({ ...SUMMARY, line: "Refund bug fixed" });
        yield* wait(1);
        yield* writeDue(model);
        return {
          inFlight,
          before,
          stale,
          summarized,
          askedDuringPacing,
          asked: model.asked.length,
          row: yield* readRow(task.id),
          taskId: task.id,
        };
      }),
      published,
    );
    expect(result.inFlight).toBe(1);
    expect(result.stale).toMatchObject({
      line: SUMMARY.line,
      dirty_revision: 2,
      input_revision: 1,
      attempt_count: 0,
      failed_at: null,
      dirty_at: result.before?.dirty_at,
      next_attempt_at: result.before?.next_attempt_at,
    });
    expect(result.stale?.dirty_at).not.toBeNull();
    expect(result.summarized).toHaveLength(1);
    expect(published.filter((change) => change._tag === "record")).toContainEqual({
      _tag: "record",
      topic: "task",
      id: result.taskId,
      kind: "updated",
      derived: true,
    });
    expect(result.askedDuringPacing).toBe(1);
    expect(result.asked).toBe(2);
    expect(result.row).toMatchObject({
      line: "Refund bug fixed",
      input_revision: 2,
      dirty_at: null,
    });
  });

  it("is stored for a Task that changes during every call, which would otherwise never get a summary", async () => {
    const row = await run(
      Effect.gen(function* () {
        const model = buildStandInModel();
        const during = yield* duringCall;
        const task = yield* createTask("Add a refund button");
        model.answer = () => Effect.andThen(during(markDirty(task.id)), Effect.succeed(SUMMARY));
        yield* makeDue(task.id);
        yield* writeDue(model);
        return yield* readRow(task.id);
      }),
    );
    expect(row?.line).toBe(SUMMARY.line);
    expect(row?.dirty_at).not.toBeNull();
  });

  it("is dropped when the row already holds a summary made from a newer revision", async () => {
    const row = await run(
      Effect.gen(function* () {
        const model = buildStandInModel();
        const gate = yield* Deferred.make<void>();
        // The first call is slow; the call that starts after the pacing is quick.
        model.answer = () =>
          model.asked.length === 1
            ? Effect.andThen(Deferred.await(gate), Effect.succeed(SUMMARY))
            : Effect.succeed({ ...SUMMARY, line: "Newer" });
        const task = yield* createTask("Add a refund button");
        yield* makeDue(task.id);
        const slow = yield* Effect.forkChild(writeDue(model));
        yield* settle;
        yield* markDirty(task.id);
        yield* wait(SUMMARY_MIN_INTERVAL_SECONDS);
        yield* writeDue(model);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(slow);
        return yield* readRow(task.id);
      }),
    );
    expect(row).toMatchObject({ line: "Newer", input_revision: 2, dirty_at: null });
  });
});

describe("an answer or a failure that arrives after the Task ended", () => {
  it.each([
    ["finished", finishTask],
    ["deleted", deleteTask],
  ])("is dropped when the Task is %s meanwhile", async (_name, end) => {
    const result = await run(
      Effect.gen(function* () {
        const during = yield* duringCall;
        const answered = buildStandInModel();
        const failed = buildStandInModel();
        const first = yield* createTask("Add a refund button");
        const second = yield* createTask("Fix the login redirect");
        answered.answer = (taskId) => Effect.andThen(during(end(taskId)), Effect.succeed(SUMMARY));
        failed.answer = (taskId) => Effect.andThen(during(end(taskId)), Effect.fail("late"));
        yield* makeDue(first.id);
        yield* writeDue(answered);
        yield* makeDue(second.id);
        yield* writeDue(failed);
        return { first: yield* readRow(first.id), second: yield* readRow(second.id) };
      }),
    );
    expect(result.first).toMatchObject({ line: null, attempt_count: 0, failed_at: null });
    expect(result.second).toMatchObject({ line: null, attempt_count: 0, failed_at: null });
  });
});

describe("a failed attempt", () => {
  it("keeps the last summary, shows the Task as dirty, and waits twice as long each time, up to an hour", async () => {
    const result = await run(
      Effect.gen(function* () {
        const model = buildStandInModel();
        const task = yield* createTask("Add a refund button");
        yield* makeDue(task.id);
        yield* writeDue(model);
        yield* makeDue(task.id);
        // The pacing of the first attempt must pass before the next one.
        yield* wait(SUMMARY_MIN_INTERVAL_SECONDS);
        const waits: Array<number> = [];
        for (let failure = 1; failure <= 6; failure += 1) {
          model.answer = () => Effect.fail(`provider said no ${String(failure)}`);
          yield* writeDue(model);
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
        const model = buildStandInModel();
        const task = yield* createTask("Add a refund button");
        model.answer = () => Effect.fail("no");
        yield* makeDue(task.id);
        yield* writeDue(model);
        yield* wait(3600);
        model.answer = () => Effect.succeed(SUMMARY);
        yield* writeDue(model);
        return yield* readRow(task.id);
      }),
    );
    expect(row).toMatchObject({ attempt_count: 0, failed_at: null, failed_reason: null });
  });

  it("is not recorded when the Task changed since the call began: it says nothing about the Task now", async () => {
    const result = await run(
      Effect.gen(function* () {
        const model = buildStandInModel();
        const during = yield* duringCall;
        const task = yield* createTask("Add a refund button");
        model.answer = () => Effect.andThen(during(markDirty(task.id)), Effect.fail("late"));
        yield* makeDue(task.id);
        yield* writeDue(model);
        return yield* readRow(task.id);
      }),
    );
    expect(result).toMatchObject({
      line: null,
      attempt_count: 0,
      failed_at: null,
      failed_reason: null,
    });
  });

  it("is cut to the length that is stored", async () => {
    const row = await run(
      Effect.gen(function* () {
        const model = buildStandInModel();
        model.answer = () => Effect.fail("x".repeat(2000));
        const task = yield* createTask("Add a refund button");
        yield* makeDue(task.id);
        yield* writeDue(model);
        return yield* readRow(task.id);
      }),
    );
    expect(row?.failed_reason?.length).toBeLessThanOrEqual(500);
    expect(row?.attempt_count).toBe(1);
  });
});

describe("the trouble of one Task", () => {
  it.each([
    ["a failure", (): Effect.Effect<SummaryText, string> => Effect.fail("no")],
    [
      "a defect",
      (): Effect.Effect<SummaryText, string> => Effect.die(new Error("the model broke")),
    ],
  ])("as %s does not stop the Task beside it, nor the next call", async (_name, trouble) => {
    const result = await run(
      Effect.gen(function* () {
        const model = buildStandInModel();
        const broken = yield* createTask("broken");
        const fine = yield* createTask("fine");
        model.answer = (taskId) => (taskId === broken.id ? trouble() : Effect.succeed(SUMMARY));
        yield* markDirty(broken.id);
        yield* markDirty(fine.id);
        yield* wait(SUMMARY_QUIET_SECONDS);
        yield* writeDue(model);
        const later = yield* createTask("later");
        yield* makeDue(later.id);
        yield* writeDue(model);
        return {
          fine: yield* readRow(fine.id),
          later: yield* readRow(later.id),
          broken: yield* readRow(broken.id),
        };
      }),
    );
    expect(result.fine?.line).toBe(SUMMARY.line);
    expect(result.later?.line).toBe(SUMMARY.line);
    expect(result.broken?.line).toBeNull();
  });
});

describe("the reads and writes of the repository", () => {
  /** Returns the plan SQLite makes for the first statement `effect` runs. */
  const planOf = <E>(
    effect: (
      tasks: Effect.Success<typeof taskRepository>,
    ) => Effect.Effect<unknown, E, SqlClient.SqlClient>,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tasks = yield* taskRepository;
        const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
        yield* withTransaction(
          sql,
          effect(tasks).pipe(
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

  it("read the Tasks that are due from the index of dirty rows, in its own order", async () => {
    const plan = await planOf((tasks) =>
      tasks.claimSummaryAttempts({
        limit: 2,
        at: "2026-11-07T10:00:00.000Z",
        quietBefore: "2026-11-07T09:59:30.000Z",
        nextAttemptAt: "2026-11-07T10:05:00.000Z",
      }),
    );
    expect(plan.join("\n")).toContain("USING INDEX task_summaries_dirty");
    expect(plan.some((step) => step.includes("TEMP B-TREE"))).toBe(false);
  });

  it("read the time the first Task is due from the index of dirty rows and scan neither table", async () => {
    const plan = await planOf((tasks) => tasks.readNextSummaryDueAt(SUMMARY_QUIET_SECONDS));
    expect(plan.join("\n")).toContain("USING INDEX task_summaries_dirty");
    expect(plan.filter((step) => step.startsWith("SCAN") && !step.includes("USING"))).toEqual([]);
  });

  it("never make a row for a Task that has none, so a late write cannot recreate a deleted one", async () => {
    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tasks = yield* taskRepository;
        const inTransaction = <A, E>(effect: Effect.Effect<A, E, never>) =>
          withTransaction(sql, effect);
        const task = yield* createTask("Add a refund button");
        return {
          written: yield* inTransaction(
            tasks.writeSummary({
              taskId: task.id,
              dirtyRevision: 1,
              summary: SUMMARY,
              at: at(0),
            }),
          ),
          failed: yield* inTransaction(
            tasks.writeSummaryFailure({
              taskId: task.id,
              dirtyRevision: 1,
              reason: "late",
              at: at(0),
              chooseNextAttempt: () => at(60),
            }),
          ),
          row: yield* readRow(task.id),
        };
      }),
    );
    expect(result).toEqual({ written: false, failed: false, row: undefined });
  });
});
