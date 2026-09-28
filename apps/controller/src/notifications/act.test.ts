/**
 * Tests the parts of `notification.act` that HTTP cannot reach: two answers
 * taken at once, an operation that resolves the decision itself, and a caller
 * that is a run. The notification service and the database are real; the
 * port that runs operations is a fake whose `run` each test chooses.
 */
import { describe, expect, it } from "vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { createNotFoundError, type BindableOperation, type BoundAction } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { TestDatabase } from "../db/testing";
import { AuditLogLayer } from "../events";
import { BindableOperations, type BindableOperationError } from "./bindable-operations";
import { Notifier, NotifierLayer } from "./notifier";
import { NotificationService, NotificationServiceLayer } from "./service";
import { insertOpenDecision, readStoredNotification } from "./testing";

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

const TASK_ID = "0199e0e7-0002-7000-8000-000000000000";

const RENAME: BoundAction = {
  id: "rename",
  label: "Rename",
  operation: { op: "task.update", input: { taskId: TASK_ID, title: "Renamed" } },
};

/** Runs one operation for a test. It is handed the notifier, so it can resolve decisions. */
type RunOperation = (
  operation: BindableOperation,
  notifier: Notifier["Service"],
) => Effect.Effect<void, BindableOperationError>;

/**
 * Builds the notification service over a real database and a fake port whose
 * `run` calls `run`. Also provides the notifier.
 */
const buildLayer = (run: RunOperation) =>
  NotificationServiceLayer.pipe(
    Layer.provide(
      Layer.effect(BindableOperations)(
        Effect.gen(function* () {
          const notifier = yield* Notifier;
          return BindableOperations.of({
            run: (operation) => run(operation, notifier),
            describe: () => Effect.succeed([]),
          });
        }),
      ),
    ),
    Layer.provideMerge(NotifierLayer),
    Layer.provideMerge(AuditLogLayer),
    Layer.provideMerge(TestDatabase),
  );

/** Inserts an open decision about the task, whose one answer renames it. */
const insertRenameDecision = insertOpenDecision({ kind: "task", id: TASK_ID }, [RENAME]);

describe("notification.act", () => {
  it("lets a second answer wait for the first, and run once the first has failed", async () => {
    const entered = Effect.runSync(Deferred.make<void>());
    const release = Effect.runSync(Deferred.make<void>());
    let calls = 0;
    // The first run waits for the test, then fails, so the decision stays
    // open for the second answer. Later runs succeed.
    const run: RunOperation = () => {
      calls += 1;
      return calls === 1
        ? Effect.andThen(
            Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(release)),
            Effect.fail(createNotFoundError("no such task")),
          )
        : Effect.void;
    };

    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        const id = yield* insertRenameDecision;
        const first = yield* Effect.forkChild(
          Effect.flip(notifications.act({ id, actionId: "rename" })),
        );
        yield* Deferred.await(entered);
        const second = yield* Effect.forkChild(notifications.act({ id, actionId: "rename" }));
        yield* Deferred.succeed(release, undefined);
        return { first: yield* Fiber.join(first), second: yield* Fiber.join(second) };
      }).pipe(Effect.provide(buildLayer(run)), Effect.provideService(CurrentActor, USER)),
    );

    expect(outcome.first).toMatchObject({ error: { code: "not_found" } });
    expect(outcome.second.resolution).toMatchObject({ kind: "decided", actionId: "rename" });
    expect(calls).toBe(2);
  });

  it("refuses a second answer once the first has resolved the decision, and runs nothing", async () => {
    let calls = 0;
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        const id = yield* insertRenameDecision;
        yield* notifications.act({ id, actionId: "rename" });
        return yield* Effect.flip(notifications.act({ id, actionId: "rename" }));
      }).pipe(
        Effect.provide(
          buildLayer(() =>
            Effect.sync(() => {
              calls += 1;
            }),
          ),
        ),
        Effect.provideService(CurrentActor, USER),
      ),
    );

    expect(outcome).toMatchObject({
      error: {
        code: "invalid_state",
        message: expect.stringMatching(/already resolved/) as unknown,
      },
    });
    expect(calls).toBe(1);
  });

  it("accepts an operation that resolves the decision itself with the same answer", async () => {
    // `session.respond` does this: it resolves the approval decision about
    // the request it answers, with the answer the user took.
    let id = "";
    const stored = await Effect.runPromise(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        id = yield* insertRenameDecision;
        yield* notifications.act({ id, actionId: "rename" });
        return yield* readStoredNotification(id);
      }).pipe(
        Effect.provide(buildLayer((_, notifier) => Effect.asVoid(notifier.decide(id, "rename")))),
        Effect.provideService(CurrentActor, USER),
      ),
    );

    expect(stored.resolution).toMatchObject({ kind: "decided", actionId: "rename" });
  });

  it("refuses a run, which passes every grant check, and leaves the decision open", async () => {
    let calls = 0;
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const notifications = yield* NotificationService;
        const id = yield* insertRenameDecision;
        const refused = yield* Effect.flip(
          Effect.provideService(notifications.act({ id, actionId: "rename" }), CurrentActor, {
            _tag: "run",
            runId: "0199e0e7-0003-7000-8000-000000000000",
            stepId: "ask",
            workflowId: null,
          }),
        );
        return { refused, stored: yield* readStoredNotification(id) };
      }).pipe(
        Effect.provide(
          buildLayer(() =>
            Effect.sync(() => {
              calls += 1;
            }),
          ),
        ),
      ),
    );

    expect(outcome.refused).toMatchObject({
      error: {
        code: "forbidden",
        message: expect.stringMatching(/^only the user may take an answer/) as unknown,
      },
    });
    expect(outcome.stored.status).toBe("open");
    expect(calls).toBe(0);
  });
});
