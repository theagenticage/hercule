/**
 * Tests the parts of `notification.act` that HTTP cannot reach: a second
 * answer taken while the first one's operation still runs, and a caller that
 * is a run. The notification service and the database are real; the task
 * service is a fake whose `update` the test can hold.
 */
import { describe, expect, it } from "vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { createNotFoundError, type BoundAction } from "@hercule/contract";
import { CurrentActor, type Actor } from "../../actor";
import { TestDatabase } from "../../db/testing";
import { AuditLogLayer } from "../../events";
import {
  NotificationServiceTestLayer,
  insertOpenDecision,
  readStoredNotification,
} from "../../notifications/testing";
import { RunService } from "../../runs";
import { TaskService } from "../../tasks";
import { Live } from "../sessions";
import { Answering, AnsweringLayer } from "./answering";

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

/**
 * Builds the layer of `Answering` over a fake task service whose `update`
 * runs `update`. The run service and `Live` are never called by these tests.
 */
const buildLayer = (update: () => Effect.Effect<unknown, ReturnType<typeof createNotFoundError>>) =>
  AnsweringLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(TaskService, { update } as unknown as TaskService["Service"]),
        Layer.succeed(RunService, {} as RunService["Service"]),
        Layer.succeed(Live, {} as Live["Service"]),
      ),
    ),
    Layer.provideMerge(NotificationServiceTestLayer),
    Layer.provideMerge(AuditLogLayer),
    Layer.provideMerge(TestDatabase),
  );

describe("Answering.act", () => {
  it("refuses a second answer while the first one's operation runs, and releases the hold after", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let calls = 0;
        // The first update waits for the test, then fails, so the decision
        // stays open for the third answer. Later updates succeed.
        const update = () => {
          calls += 1;
          return calls === 1
            ? Effect.andThen(
                Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(release)),
                Effect.fail(createNotFoundError("no such task")),
              )
            : Effect.void;
        };
        return yield* Effect.gen(function* () {
          const answering = yield* Answering;
          const id = yield* insertOpenDecision({ kind: "task", id: TASK_ID }, [RENAME]);

          const first = yield* Effect.forkChild(
            Effect.flip(answering.act({ id, actionId: "rename" })),
          );
          yield* Deferred.await(entered);
          const second = yield* Effect.flip(answering.act({ id, actionId: "rename" }));
          yield* Deferred.succeed(release, undefined);
          const firstError = yield* Fiber.join(first);
          const third = yield* answering.act({ id, actionId: "rename" });
          return { first: firstError, second, third, calls };
        }).pipe(Effect.provide(buildLayer(update)));
      }).pipe(Effect.provideService(CurrentActor, USER)),
    );

    expect(outcome.first).toMatchObject({ error: { code: "not_found" } });
    expect(outcome.second).toMatchObject({
      error: {
        code: "invalid_state",
        message: expect.stringMatching(/already being taken/) as unknown,
      },
    });
    // The second answer never reached the operation.
    expect(outcome.calls).toBe(2);
    expect(outcome.third.resolution).toMatchObject({ kind: "decided", actionId: "rename" });
  });

  it("refuses a run, which passes every grant check, and leaves the decision open", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const answering = yield* Answering;
        const id = yield* insertOpenDecision({ kind: "task", id: TASK_ID }, [RENAME]);
        const refused = yield* Effect.flip(
          Effect.provideService(answering.act({ id, actionId: "rename" }), CurrentActor, {
            _tag: "run",
            runId: "0199e0e7-0003-7000-8000-000000000000",
            stepId: "ask",
            workflowId: null,
          }),
        );
        return { refused, stored: yield* readStoredNotification(id) };
      }).pipe(Effect.provide(buildLayer(() => Effect.void))),
    );

    expect(outcome.refused).toMatchObject({
      error: {
        code: "forbidden",
        message: expect.stringMatching(/^only the user may take an answer/) as unknown,
      },
    });
    expect(outcome.stored.status).toBe("open");
  });
});
