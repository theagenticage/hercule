/**
 * Tests that a rolled-back mutation publishes nothing.
 *
 * An invalidation tells a client that a record changed, and the client
 * refetches. So it must be sent only after the write is committed. A
 * transaction that rolls back has changed nothing, however far it got, and a
 * subscriber told otherwise would refetch a task that was never written, and
 * would see something the log does not hold.
 *
 * The important case is the one that gets furthest: a mutation whose audit
 * row is already written when the transaction fails. Transactions are ambient
 * and nest, so wrapping `task.create` in an outer `withTransaction` that then
 * fails gives exactly that: the task row and the `task.created` audit row are
 * both written, and both are rolled back.
 *
 * An HTTP test cannot show this, because no route fails after writing its
 * audit row, so this test calls the service directly.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer, Queue } from "effect";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { LiveMessage } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { withTransaction } from "../db";
import { TestDatabase } from "../db/testing";
import { AuditLog, AuditLogLayer, PlatformEventsLayer } from "../events";
import { NotifierLayer } from "../notifications";
import { TaskService, TaskServiceLayer } from "../tasks";
import { LiveTopics, LiveTopicsLayer, type LiveQueue } from "./topics";

type Deps = TaskService | AuditLog | LiveTopics | SqlClient.SqlClient;

const layer = TaskServiceLayer.pipe(
  Layer.provideMerge(NotifierLayer),
  Layer.provideMerge(Layer.mergeAll(AuditLogLayer, PlatformEventsLayer)),
  Layer.provideMerge(LiveTopicsLayer),
  Layer.provideMerge(TestDatabase),
);

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

const run = <A, E>(effect: Effect.Effect<A, E, Deps | Scope.Scope>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(Effect.provideService(CurrentActor, USER), Effect.provide(layer)),
  );

/** The error the failing transaction fails with. Nothing reads it; it only aborts. */
class Rollback {
  readonly _tag = "Rollback";
}

/**
 * Waits briefly for messages, then returns everything the subscription has
 * received. The publish happens after the commit, so reading right after the
 * write would test the timing, not the behaviour.
 */
const takeSettledMessages = (queue: LiveQueue): Effect.Effect<ReadonlyArray<LiveMessage>> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 20; attempt++) {
      const size = yield* Queue.size(queue);
      if (size > 0) break;
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.orDie(Queue.clear(queue));
  });

describe("publishing after a commit", () => {
  it("publishes nothing for a transaction that rolled back after its audit row was written", async () => {
    const held = await run(
      Effect.gen(function* () {
        const topics = yield* LiveTopics;
        const tasks = yield* TaskService;
        const sql = yield* SqlClient.SqlClient;
        const queue = yield* topics.subscribe("task");

        yield* Effect.ignore(
          withTransaction(
            sql,
            Effect.gen(function* () {
              yield* tasks.create({ title: "a task nobody will hear about", description: "" });
              return yield* Effect.fail(new Rollback());
            }),
          ),
        );

        return yield* takeSettledMessages(queue);
      }),
    );

    expect(held).toEqual([]);
  });

  it("publishes nothing for an inner transaction that rolled back inside one that committed", async () => {
    const [held, kept] = await run(
      Effect.gen(function* () {
        const topics = yield* LiveTopics;
        const tasks = yield* TaskService;
        const sql = yield* SqlClient.SqlClient;
        const queue = yield* topics.subscribe("task");

        const task = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            // A savepoint is rolled back and the outer transaction continues
            // and commits. Only what it kept is published.
            yield* Effect.ignore(
              withTransaction(
                sql,
                Effect.andThen(
                  tasks.create({ title: "a task that was thought better of", description: "" }),
                  Effect.fail(new Rollback()),
                ),
              ),
            );
            return yield* tasks.create({ title: "a task that stayed", description: "" });
          }),
        );

        return [yield* takeSettledMessages(queue), task.id] as const;
      }),
    );

    expect(held).toEqual([{ _tag: "invalidate", ids: [kept], kind: "created" }]);
  });

  it("publishes the same mutation when its transaction commits", async () => {
    const [held, id] = await run(
      Effect.gen(function* () {
        const topics = yield* LiveTopics;
        const tasks = yield* TaskService;
        const sql = yield* SqlClient.SqlClient;
        const queue = yield* topics.subscribe("task");

        const task = yield* withTransaction(
          sql,
          tasks.create({ title: "a task that sticks", description: "" }),
        );

        return [yield* takeSettledMessages(queue), task.id] as const;
      }),
    );

    expect(held).toEqual([{ _tag: "invalidate", ids: [id], kind: "created" }]);
  });
});
