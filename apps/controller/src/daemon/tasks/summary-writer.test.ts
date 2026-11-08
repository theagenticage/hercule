/**
 * Tests the summary writer's loop on real rows, with a clock the test moves and
 * a stand-in for the model (the edge of the system). It tests what the loop
 * adds to `TaskSummaries.writeDue`:
 *
 * - that it sleeps until the first Task is due, wakes when a Task is marked,
 *   and never spins;
 * - that a model that is Off, or that no runner can run, costs no attempt;
 * - what the describer records when the model fails or answers badly.
 *
 * The rules of writing (which Tasks are due, the pacing, a late answer, one
 * Task's trouble) are tested in `tasks/summaries.test.ts`; the input and the
 * answer's parsing in `summary-input.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Clock, Duration, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import { CurrentActor, type Actor } from "../../actor";
import { AfterCommit, uuidFromString, withTransaction } from "../../db";
import { TestDatabase } from "../../db/testing";
import { AuditLogLayer, PlatformEventsLayer } from "../../events";
import { NotifierLayer } from "../../notifications";
import { PluginHost } from "../../plugins";
import { buildPluginStack } from "../../plugins/testing";
import { ServingPromotionStateLayer } from "../../promotion/testing";
import { ModelCatalogsLayer, ProviderAccountRunnersLayer } from "../../provider-accounts";
import { inertMembership } from "../../provider-accounts/testing";
import { Settings, SettingsLayer } from "../../settings";
import {
  makeSummaryWake,
  TaskService,
  TaskServiceLayer,
  TaskSummariesLayer,
  TaskSummaryWake,
} from "../../tasks";
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
import { TaskServicePortsLayer } from "./task-service";
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
    TaskServiceLayer.pipe(Layer.provide(TaskServicePortsLayer)),
    TaskSummariesLayer.pipe(Layer.provide(ServingPromotionStateLayer)),
    TaskTrackingRunsLayer,
    TextGenerationModelsLayer,
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
type Services =
  | Effect.Services<typeof runTaskSummaryLoop>
  | TaskService
  | Settings
  | SqlClient.SqlClient;

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
        const row = yield* readRow(task.id);
        // Once written, the loop sleeps: nothing is due for an hour.
        yield* elapse(3600);
        yield* Fiber.interrupt(loop);
        return { idle, beforeDue, calls: model.calls, row };
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
  it("does not spin: the loop sleeps until the Task is due again, and notices within its backstop", async () => {
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

    // Waits of 10, 20, 40 minutes and then an hour (see `tasks/summaries.test.ts`) leave
    // about six calls in four hours. The second one comes within the backstop of the first wait.
    expect(result.times.length).toBeGreaterThanOrEqual(5);
    expect(result.times.length).toBeLessThanOrEqual(7);
    expect(result.times[1]! - result.times[0]!).toBeGreaterThanOrEqual(600);
    expect(result.times[1]! - result.times[0]!).toBeLessThan(720);
    expect(result.row).toMatchObject({ line: null, attempt_count: result.times.length });
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
});
