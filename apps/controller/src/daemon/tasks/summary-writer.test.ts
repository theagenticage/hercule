/**
 * Tests the summary writer's loop on real rows, with a clock the test moves and
 * a stand-in for the model (the edge of the system):
 *
 * - how many calls a burst of changes makes, and how many run at once;
 * - what happens to an answer that arrives after the Task changed;
 * - what a restart, a model that is Off and a failing model do to the pacing;
 * - that one Task's trouble does not stop the others.
 *
 * The bookkeeping itself (which Tasks are due, how a write is guarded) is
 * tested in `tasks/summary.test.ts`; the input and the answer's parsing in
 * `summary-input.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Clock, Deferred, Duration, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import { CurrentActor, type Actor } from "../../actor";
import { AfterCommit, uuidFromString, withTransaction } from "../../db";
import { TestDatabase } from "../../db/testing";
import { AuditLogLayer, PlatformEventsLayer } from "../../events";
import { readEventsOfKind } from "../../events/testing";
import { NotifierLayer } from "../../notifications";
import { PluginHost } from "../../plugins";
import { buildPluginStack } from "../../plugins/testing";
import { ServingPromotionStateLayer } from "../../promotion/testing";
import { ModelCatalogsLayer, ProviderAccountRunnersLayer } from "../../provider-accounts";
import { inertMembership } from "../../provider-accounts/testing";
import { Settings, SettingsLayer } from "../../settings";
import { makeSummaryWake, TaskService, TaskServiceLayer, TaskSummaryWake } from "../../tasks";
import {
  TextGeneration,
  TextGenerationError,
  TextGenerationModels,
  TextGenerationModelsLayer,
} from "../../text-generation";
import {
  addCatalog,
  addFixtureAccount,
  addSnapshot,
  addTextGenerationRunner,
  buildProbeResult,
  buildTextGenerationPlugins,
  type RunnerTraits,
} from "../../text-generation/testing";
import { AccountUsageLayer } from "../../usage";
import { TaskTrackingRunsLayer } from "../runs";
import { TaskLinkOwnersLayer } from "./link-owners";
import { runTaskSummaryLoop } from "./summary-writer";

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

const GOOD_ANSWER = {
  line: "Refund bug found",
  standing: "The gift card path fails.",
  left: "A fix.",
};

/** One call the stand-in model received. */
interface ModelCall {
  /** The title of the Task the call is about, read from the call's input. */
  readonly title: string;
  /** The clock's time in milliseconds when the call arrived. */
  readonly at: number;
}

/**
 * The stand-in for the model. `answer` decides what a call returns, and a test
 * changes it between calls; the rest records what the writer did.
 */
interface StandInModel {
  readonly calls: Array<ModelCall>;
  inFlight: number;
  mostInFlight: number;
  answer: (title: string) => Effect.Effect<unknown, TextGenerationError>;
}

const buildStandInModel = (): StandInModel => ({
  calls: [],
  inFlight: 0,
  mostInFlight: 0,
  answer: () => Effect.succeed(GOOD_ANSWER),
});

const layerOf = (model: StandInModel) =>
  Layer.mergeAll(
    TaskServiceLayer.pipe(Layer.provide(TaskLinkOwnersLayer)),
    TaskTrackingRunsLayer,
    TextGenerationModelsLayer,
    ServingPromotionStateLayer,
    Layer.succeed(TextGeneration)({
      generate: (call) =>
        Effect.gen(function* () {
          const title = (JSON.parse(call.input) as { task: { title: string } }).task.title;
          model.calls.push({ title, at: yield* Clock.currentTimeMillis });
          model.inFlight += 1;
          model.mostInFlight = Math.max(model.mostInFlight, model.inFlight);
          return yield* Effect.ensuring(
            model.answer(title),
            Effect.sync(() => {
              model.inFlight -= 1;
            }),
          );
        }),
    }),
  ).pipe(
    Layer.provideMerge(NotifierLayer),
    Layer.provideMerge(Layer.mergeAll(AuditLogLayer, PlatformEventsLayer)),
    Layer.provideMerge(ModelCatalogsLayer),
    Layer.provideMerge(inertMembership),
    Layer.provideMerge(ProviderAccountRunnersLayer),
    Layer.provideMerge(AccountUsageLayer),
    Layer.provideMerge(SettingsLayer),
    Layer.provideMerge(buildPluginStack()),
    Layer.provideMerge(Layer.succeed(AfterCommit)({ publish: () => Effect.void })),
    Layer.provideMerge(TestDatabase),
  );

/** What a test body may use: the loop's own services, the settings and the tasks. */
type Services = Effect.Services<typeof runTaskSummaryLoop> | Settings | SqlClient.SqlClient;

/**
 * Runs `body` on a fresh database, with a Text Generation Model that a
 * runner can run (unless `runner` says otherwise) and a clock that starts at
 * the epoch and moves only when the test moves it.
 */
const run = <A, E>(
  body: (model: StandInModel) => Effect.Effect<A, E, Services>,
  runner: RunnerTraits = {},
) => {
  const model = buildStandInModel();
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.flatMap(PluginHost, (host) => host.boot(buildTextGenerationPlugins()));
      const account = yield* addFixtureAccount("openai");
      const runnerId = yield* addTextGenerationRunner(runner);
      const probed = buildProbeResult("ok", "gpt-6-luna");
      yield* addSnapshot(account.id, account.defaultHarnessId, runnerId, probed);
      yield* addCatalog(account.id, probed);
      return yield* body(model);
    }).pipe(
      Effect.provideService(CurrentActor, USER),
      Effect.provideService(TaskSummaryWake, makeSummaryWake()),
      Effect.provide(layerOf(model)),
      Effect.provide(TestClock.layer()),
      Effect.orDie,
    ),
  );
};

/**
 * Moves the clock forward in steps of ten seconds, letting the loop run after
 * each, so it sees the time pass the way it does in a controller.
 */
const elapse = (seconds: number) =>
  Effect.forEach(
    Array.from({ length: Math.ceil(seconds / 10) }),
    () =>
      Effect.andThen(
        TestClock.adjust(Duration.seconds(10)),
        Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true }),
      ),
    { discard: true },
  );

const startLoop = Effect.forkChild(runTaskSummaryLoop);

const createTask = (title: string) =>
  Effect.flatMap(TaskService, (tasks) =>
    tasks.create({ title, description: "", stage: "building" }),
  );

const markDirty = (taskId: string) =>
  Effect.flatMap(TaskService, (tasks) => tasks.markSummaryDirty(taskId));

const readRow = (taskId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly line: string | null;
      readonly dirty_revision: number;
      readonly input_revision: number;
      readonly dirty_at: string | null;
      readonly last_attempt_at: string | null;
      readonly next_attempt_at: string | null;
      readonly attempt_count: number;
      readonly failed_reason: string | null;
    }>`SELECT line, dirty_revision, input_revision, dirty_at, last_attempt_at, next_attempt_at,
              attempt_count, failed_reason
       FROM task_summaries WHERE task_id = ${uuidFromString(taskId)}`;
    return rows[0]!;
  });

const failing = (reason: "timeout" | "unavailable" = "timeout") =>
  Effect.fail(new TextGenerationError({ reason, message: "the model did not answer" }));

describe("the calls the writer makes", () => {
  it("makes one call for a Task however many changes, at the same moment or spread out, came before it", async () => {
    const result = await run((model) =>
      Effect.gen(function* () {
        const task = yield* createTask("Add a refund button");
        const loop = yield* startLoop;
        yield* Effect.all([markDirty(task.id), markDirty(task.id)], { concurrency: 2 });
        yield* elapse(10);
        yield* markDirty(task.id);
        yield* elapse(10);
        yield* markDirty(task.id);
        const beforeQuiet = model.calls.length;
        yield* elapse(120);
        const afterQuiet = model.calls.length;
        yield* elapse(3600);
        yield* Fiber.interrupt(loop);
        return { beforeQuiet, afterQuiet, calls: model.calls.length, row: yield* readRow(task.id) };
      }),
    );

    expect(result.beforeQuiet).toBe(0);
    expect(result.afterQuiet).toBe(1);
    expect(result.calls).toBe(1);
    expect(result.row).toMatchObject({ dirty_revision: 4, input_revision: 4, dirty_at: null });
  });

  it("stores the answer without touching the Task, and then waits for the next change", async () => {
    const result = await run((model) =>
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        model.answer = () => Effect.succeed({ ...GOOD_ANSWER, line: "" });
        const task = yield* createTask("Add a refund button");
        yield* markDirty(task.id);
        const before = yield* tasks.read(task.id);
        const updatedEvents = (yield* readEventsOfKind("task.updated")).length;
        const loop = yield* startLoop;
        yield* elapse(3600);
        yield* Fiber.interrupt(loop);
        return {
          before,
          after: yield* tasks.read(task.id),
          updatedEventsAfter: (yield* readEventsOfKind("task.updated")).length,
          updatedEvents,
          calls: model.calls.length,
          row: yield* readRow(task.id),
        };
      }),
    );

    expect(result.calls).toBe(1);
    // An empty line is stored as it is: the card keeps its fallback.
    expect(result.row).toMatchObject({ line: "", dirty_revision: 1, dirty_at: null });
    expect(result.after.updatedAt).toBe(result.before.updatedAt);
    expect(result.updatedEventsAfter).toBe(result.updatedEvents);
  });

  it("never has more than two calls in flight, and still drains the backlog", async () => {
    const result = await run((model) =>
      Effect.gen(function* () {
        model.answer = () =>
          Effect.andThen(Effect.sleep(Duration.seconds(20)), Effect.succeed(GOOD_ANSWER));
        const ids = yield* Effect.forEach(["a", "b", "c", "d", "e"], (title) =>
          Effect.map(createTask(title), (task) => task.id),
        );
        yield* Effect.forEach(ids, markDirty);
        const loop = yield* startLoop;
        yield* elapse(300);
        yield* Fiber.interrupt(loop);
        const rows = yield* Effect.forEach(ids, readRow);
        return { mostInFlight: model.mostInFlight, calls: model.calls.length, rows };
      }),
    );

    expect(result.mostInFlight).toBe(2);
    expect(result.calls).toBe(5);
    expect(result.rows.map((row) => row.dirty_at)).toEqual([null, null, null, null, null]);
  });

  it.each([
    [
      "done",
      (id: string) => Effect.flatMap(TaskService, (tasks) => tasks.update({ id, stage: "done" })),
    ],
    [
      "dropped",
      (id: string) =>
        Effect.flatMap(TaskService, (tasks) => tasks.update({ id, stage: "dropped" })),
    ],
    ["deleted", (id: string) => Effect.flatMap(TaskService, (tasks) => tasks.delete(id))],
  ])("makes no call for a Task that is %s before it is due", async (_name, end) => {
    const calls = await run((model) =>
      Effect.gen(function* () {
        const task = yield* createTask("Add a refund button");
        yield* markDirty(task.id);
        const loop = yield* startLoop;
        yield* elapse(10);
        yield* end(task.id);
        yield* elapse(3600);
        yield* Fiber.interrupt(loop);
        return model.calls.length;
      }),
    );

    expect(calls).toBe(0);
  });
});

describe("a Task merged away", () => {
  it("makes no call before it is due, and the survivor, marked dirty by the merge, gets one", async () => {
    const result = await run((model) =>
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const source = yield* createTask("Add a refund button");
        const survivor = yield* createTask("Refund flow");
        yield* markDirty(source.id);
        const loop = yield* startLoop;
        yield* elapse(10);
        yield* tasks.merge(source.id, { intoTaskId: survivor.id });
        yield* elapse(3600);
        yield* Fiber.interrupt(loop);
        return { titles: model.calls.map((call) => call.title), row: yield* readRow(survivor.id) };
      }),
    );

    expect(result.titles).toEqual(["Refund flow"]);
    expect(result.row).toMatchObject({ dirty_at: null, line: "Refund bug found" });
  });
});

describe("an answer that arrives after the Task changed", () => {
  it("is stored as a stale summary, and the next call waits for the pacing of the first and then refreshes it", async () => {
    const result = await run((model) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        model.answer = () => Effect.andThen(Deferred.await(gate), Effect.succeed(GOOD_ANSWER));
        const task = yield* createTask("Add a refund button");
        yield* markDirty(task.id);
        const loop = yield* startLoop;
        yield* elapse(60);
        const inFlight = model.inFlight;
        yield* markDirty(task.id);
        yield* Deferred.succeed(gate, undefined);
        yield* elapse(10);
        const stale = yield* readRow(task.id);
        const callsAtStale = model.calls.length;
        yield* elapse(200);
        const callsDuringPacing = model.calls.length;
        model.answer = () => Effect.succeed({ ...GOOD_ANSWER, line: "Refund bug fixed" });
        yield* elapse(200);
        yield* Fiber.interrupt(loop);
        return {
          inFlight,
          stale,
          callsAtStale,
          callsDuringPacing,
          calls: model.calls.length,
          row: yield* readRow(task.id),
        };
      }),
    );

    expect(result.inFlight).toBe(1);
    // The answer is kept although the Task changed; the row is still dirty.
    expect(result.stale).toMatchObject({
      line: "Refund bug found",
      dirty_revision: 2,
      input_revision: 1,
    });
    expect(result.stale.dirty_at).not.toBeNull();
    expect(result.callsAtStale).toBe(1);
    expect(result.callsDuringPacing).toBe(1);
    expect(result.calls).toBe(2);
    expect(result.row).toMatchObject({
      line: "Refund bug fixed",
      input_revision: 2,
      dirty_at: null,
    });
  });

  it("gives a Task that changes during every call a summary all the same", async () => {
    const result = await run((model) =>
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const task = yield* createTask("Add a refund button");
        // The Task changes while each call is out.
        model.answer = () =>
          Effect.andThen(
            tasks.markSummaryDirty(task.id).pipe(Effect.orDie),
            Effect.succeed(GOOD_ANSWER),
          );
        yield* markDirty(task.id);
        const loop = yield* startLoop;
        yield* elapse(60);
        yield* Fiber.interrupt(loop);
        return yield* readRow(task.id);
      }),
    );

    expect(result.line).toBe("Refund bug found");
    expect(result.dirty_at).not.toBeNull();
  });
});

describe("the wait for the first Task to be due", () => {
  /** Starts the loop with a count of how often it looks up the Text Generation Model. */
  const startCountingLoop = (lookups: { count: number }) =>
    Effect.forkChild(
      runTaskSummaryLoop.pipe(
        Effect.updateService(TextGenerationModels, (models) => ({
          ...models,
          resolve: () => {
            lookups.count += 1;
            return models.resolve();
          },
        })),
      ),
    );

  it("looks up no model and claims nothing until a marked Task is due, then calls at that moment", async () => {
    const lookups = { count: 0 };
    const result = await run((model) =>
      Effect.gen(function* () {
        const task = yield* createTask("Add a refund button");
        const loop = yield* startCountingLoop(lookups);
        yield* elapse(10);
        const idle = { lookups: lookups.count, row: undefined as unknown };
        yield* markDirty(task.id);
        yield* elapse(10);
        yield* markDirty(task.id);
        yield* elapse(10);
        const beforeDue = { lookups: lookups.count, row: yield* readRow(task.id) };
        yield* elapse(10);
        yield* Fiber.interrupt(loop);
        return { idle, beforeDue, calls: model.calls, row: yield* readRow(task.id) };
      }),
    );

    expect(result.idle.lookups).toBe(0);
    expect(result.beforeDue.lookups).toBe(0);
    expect(result.beforeDue.row).toMatchObject({ last_attempt_at: null, next_attempt_at: null });
    expect(result.calls.map((call) => call.at)).toEqual([40_000]);
    expect(result.row).toMatchObject({ line: "Refund bug found", dirty_at: null });
  });
});

describe("a restart", () => {
  it("resumes from the rows: a Task that became due while no loop ran is written at once", async () => {
    const result = await run((model) =>
      Effect.gen(function* () {
        const task = yield* createTask("Add a refund button");
        yield* markDirty(task.id);
        const first = yield* startLoop;
        yield* elapse(10);
        yield* Fiber.interrupt(first);
        yield* elapse(60);
        const second = yield* startLoop;
        yield* elapse(10);
        yield* Fiber.interrupt(second);
        return { calls: model.calls.length, row: yield* readRow(task.id) };
      }),
    );

    expect(result.calls).toBe(1);
    expect(result.row).toMatchObject({ line: "Refund bug found", dirty_at: null });
  });

  it("repeats a call it cut off, but only after the Task's next attempt time", async () => {
    const result = await run((model) =>
      Effect.gen(function* () {
        model.answer = () => Effect.never;
        const task = yield* createTask("Add a refund button");
        yield* markDirty(task.id);
        const first = yield* startLoop;
        yield* elapse(60);
        yield* Fiber.interrupt(first);
        const cutOff = model.calls.length;
        model.answer = () => Effect.succeed(GOOD_ANSWER);
        const second = yield* startLoop;
        yield* elapse(200);
        const callsDuringPacing = model.calls.length;
        yield* elapse(200);
        yield* Fiber.interrupt(second);
        return {
          cutOff,
          callsDuringPacing,
          calls: model.calls.length,
          row: yield* readRow(task.id),
        };
      }),
    );

    expect(result).toMatchObject({ cutOff: 1, callsDuringPacing: 1, calls: 2 });
    expect(result.row.dirty_at).toBeNull();
  });
});

describe("a model that cannot run", () => {
  it("makes no call and spends no attempt while Text Generation is Off, and catches up at the next wake once it is on", async () => {
    const result = await run((model) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const settings = yield* Settings;
        yield* withTransaction(sql, settings.set("textGeneration.model", "off"));
        const task = yield* createTask("Add a refund button");
        yield* markDirty(task.id);
        const loop = yield* startLoop;
        yield* elapse(600);
        const whileOff = { calls: model.calls.length, row: yield* readRow(task.id) };
        yield* withTransaction(sql, settings.set("textGeneration.model", "automatic"));
        yield* elapse(60);
        yield* Fiber.interrupt(loop);
        return { whileOff, calls: model.calls.length, row: yield* readRow(task.id) };
      }),
    );

    expect(result.whileOff.calls).toBe(0);
    expect(result.whileOff.row).toMatchObject({ last_attempt_at: null, next_attempt_at: null });
    expect(result.whileOff.row.dirty_at).not.toBeNull();
    expect(result.calls).toBe(1);
    expect(result.row).toMatchObject({ line: "Refund bug found", dirty_at: null });
  });

  it("makes no call while no runner can run the model", async () => {
    const result = await run(
      (model) =>
        Effect.gen(function* () {
          const task = yield* createTask("Add a refund button");
          yield* markDirty(task.id);
          const loop = yield* startLoop;
          yield* elapse(600);
          yield* Fiber.interrupt(loop);
          return { calls: model.calls.length, row: yield* readRow(task.id) };
        }),
      { online: false },
    );

    expect(result.calls).toBe(0);
    expect(result.row.next_attempt_at).toBeNull();
  });
});

describe("a model that fails", () => {
  it("calls at most once every five minutes, and waits longer after each failure in a row", async () => {
    const result = await run((model) =>
      Effect.gen(function* () {
        model.answer = () => failing();
        const task = yield* createTask("Add a refund button");
        yield* markDirty(task.id);
        const loop = yield* startLoop;
        yield* elapse(4 * 3600);
        yield* Fiber.interrupt(loop);
        return { times: model.calls.map((call) => call.at / 1000), row: yield* readRow(task.id) };
      }),
    );

    const gaps = result.times.slice(1).map((time, index) => time - result.times[index]!);
    // 10, 20, 40 minutes, then the one-hour ceiling. The loop notices a Task is due
    // within its one-minute backstop.
    const waits = [600, 1200, 2400, 3600, 3600];
    expect(gaps.length).toBeGreaterThanOrEqual(waits.length);
    for (const [index, wait] of waits.entries()) {
      expect(gaps[index]).toBeGreaterThanOrEqual(wait);
      expect(gaps[index]).toBeLessThan(wait + 120);
    }
    expect(result.row).toMatchObject({ line: null, attempt_count: result.times.length });
    expect(result.row.dirty_at).not.toBeNull();
  });

  it.each([
    ["a call that fails", () => failing("unavailable"), "unavailable: the model did not answer"],
    [
      "an answer without the three texts",
      () => Effect.succeed({ line: 3 }),
      "the model's answer did not hold the three texts of a summary",
    ],
  ])("records %s as a failure and keeps the Task dirty", async (_name, answer, reason) => {
    const result = await run((model) =>
      Effect.gen(function* () {
        model.answer = answer;
        const task = yield* createTask("Add a refund button");
        yield* markDirty(task.id);
        const loop = yield* startLoop;
        yield* elapse(120);
        yield* Fiber.interrupt(loop);
        return { calls: model.calls.length, row: yield* readRow(task.id) };
      }),
    );

    expect(result.calls).toBe(1);
    expect(result.row).toMatchObject({ line: null, attempt_count: 1, failed_reason: reason });
    expect(result.row.dirty_at).not.toBeNull();
  });

  it.each([
    ["fails", () => failing()],
    ["breaks", () => Effect.die(new Error("the stand-in model broke"))],
  ])(
    "does not stop the Task beside the one whose call %s, nor the next round",
    async (_name, trouble) => {
      const result = await run((model) =>
        Effect.gen(function* () {
          model.answer = (title) => (title === "broken" ? trouble() : Effect.succeed(GOOD_ANSWER));
          const broken = yield* createTask("broken");
          const fine = yield* createTask("fine");
          yield* markDirty(broken.id);
          yield* markDirty(fine.id);
          const loop = yield* startLoop;
          yield* elapse(120);
          const later = yield* createTask("later");
          yield* markDirty(later.id);
          yield* elapse(120);
          yield* Fiber.interrupt(loop);
          return {
            fine: yield* readRow(fine.id),
            later: yield* readRow(later.id),
            broken: yield* readRow(broken.id),
          };
        }),
      );

      expect(result.fine.line).toBe("Refund bug found");
      expect(result.later.line).toBe("Refund bug found");
      expect(result.broken.line).toBeNull();
    },
  );
});
