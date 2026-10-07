/**
 * Tests what a mutable subscription receives, and when. Its first message is
 * sent at once and says that every record may have changed. After that,
 * record changes are paced: most changes are collected for 50 ms and sent
 * together. A subagent's record, and a session record whose only change is
 * its Token Usage, change with almost every event an agent reports, so those
 * are collected for a whole second instead.
 *
 * The clock is a `TestClock`, so each test moves time by hand and checks what
 * has been sent at each point, without waiting for real time to pass.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Layer, Queue } from "effect";
import type * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import type { LiveMessage } from "@hercule/contract";
import { TestDatabase } from "../db/testing";
import { subscribeSkippingFirstPush } from "./testing";
import { COALESCE_WINDOW_MS, LiveTopics, LiveTopicsLayer, SLOW_COALESCE_WINDOW_MS } from "./topics";

const SESSION = "0199e0e7-0000-7000-8000-000000000001";

const run = <A, E>(effect: Effect.Effect<A, E, LiveTopics | Scope.Scope>): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(
      Effect.provide(LiveTopicsLayer.pipe(Layer.provide(TestDatabase))),
      Effect.provide(TestClock.layer()),
    ),
  );

/** Moves the test clock forward by `ms`, letting every fiber that wakes up run. */
const advance = (ms: number) => TestClock.adjust(Duration.millis(ms));

describe("the pace of record changes", () => {
  it("sends a subagent change at most once per session per second under a burst", async () => {
    const received = await run(
      Effect.gen(function* () {
        const topics = yield* LiveTopics;
        const queue = yield* subscribeSkippingFirstPush("subagent");
        const sent: Array<ReadonlyArray<LiveMessage>> = [];

        // Thirty changes over 1.5 seconds: one every 50 ms, as a busy subagent reports.
        for (let step = 0; step < 30; step++) {
          yield* topics.publish([
            { _tag: "record", topic: "subagent", id: SESSION, kind: "updated" },
          ]);
          yield* advance(COALESCE_WINDOW_MS);
          sent.push(yield* Queue.clear(queue));
        }
        yield* advance(SLOW_COALESCE_WINDOW_MS);
        sent.push(yield* Queue.clear(queue));
        return sent;
      }),
    );

    // The first window opens at 0 ms and is sent at 1000 ms, after step 19.
    // The change at 1000 ms opens the second, which is sent at 2000 ms.
    const sendSteps = received.flatMap((messages, step) => (messages.length > 0 ? [step] : []));
    expect(sendSteps).toEqual([19, 30]);
    expect(received.flat()).toEqual([
      { _tag: "invalidate", ids: [SESSION], kind: "updated" },
      { _tag: "invalidate", ids: [SESSION], kind: "updated" },
    ]);
  });

  it("sends a session change caused by usage alone a second later, and other changes within the short window", async () => {
    const [afterShortWindow, afterLongWindow] = await run(
      Effect.gen(function* () {
        const topics = yield* LiveTopics;
        const queue = yield* subscribeSkippingFirstPush("session");
        yield* topics.publish([
          {
            _tag: "record",
            topic: "session",
            id: "usage",
            conversationId: null,
            kind: "updated",
            usageOnly: true,
          },
          { _tag: "record", topic: "session", id: "status", conversationId: null, kind: "updated" },
        ]);
        yield* advance(COALESCE_WINDOW_MS);
        const early = yield* Queue.clear(queue);
        yield* advance(SLOW_COALESCE_WINDOW_MS);
        return [early, yield* Queue.clear(queue)] as const;
      }),
    );

    expect(afterShortWindow).toEqual([
      { _tag: "invalidate", ids: ["status"], kind: "updated", conversationIds: { status: null } },
    ]);
    expect(afterLongWindow).toEqual([
      { _tag: "invalidate", ids: ["usage"], kind: "updated", conversationIds: { usage: null } },
    ]);
  });
});

describe("the conversation of a session change", () => {
  it("is sent with each session id, through a batch of several changes, and only on the session topic", async () => {
    const [sessionMessages, taskMessages] = await run(
      Effect.gen(function* () {
        const topics = yield* LiveTopics;
        const sessionQueue = yield* subscribeSkippingFirstPush("session");
        const taskQueue = yield* subscribeSkippingFirstPush("task");
        // Three sessions in one window, one of them changed twice, plus a
        // change on another topic.
        yield* topics.publish([
          { _tag: "record", topic: "session", id: "ada", conversationId: "c-ada", kind: "updated" },
          { _tag: "record", topic: "session", id: "thread", conversationId: null, kind: "updated" },
          { _tag: "record", topic: "task", id: "t1", kind: "created" },
        ]);
        yield* topics.publish([
          {
            _tag: "record",
            topic: "session",
            id: "milo",
            conversationId: "c-milo",
            kind: "updated",
          },
          { _tag: "record", topic: "session", id: "ada", conversationId: "c-ada", kind: "updated" },
        ]);
        yield* advance(COALESCE_WINDOW_MS);
        return [yield* Queue.clear(sessionQueue), yield* Queue.clear(taskQueue)] as const;
      }),
    );

    expect(sessionMessages).toEqual([
      {
        _tag: "invalidate",
        ids: ["ada", "thread", "milo"],
        kind: "updated",
        conversationIds: { ada: "c-ada", thread: null, milo: "c-milo" },
      },
    ]);
    expect(taskMessages).toEqual([{ _tag: "invalidate", ids: ["t1"], kind: "created" }]);
  });
});

describe("the first message of a mutable subscription", () => {
  it("says every record may have changed, at once, and comes before any change made after it", async () => {
    const [taskFirst, sessionFirst, afterWindow] = await run(
      Effect.gen(function* () {
        const topics = yield* LiveTopics;
        const taskQueue = yield* topics.subscribe("task");
        const sessionQueue = yield* topics.subscribe("session");
        // No time has passed, so a message that waited for a window would
        // not be here yet.
        const taskFirst = yield* Queue.clear(taskQueue);
        const sessionFirst = yield* Queue.clear(sessionQueue);
        yield* topics.publish([{ _tag: "record", topic: "task", id: "t1", kind: "created" }]);
        yield* advance(COALESCE_WINDOW_MS);
        return [taskFirst, sessionFirst, yield* Queue.clear(taskQueue)] as const;
      }),
    );

    expect(taskFirst).toEqual([{ _tag: "invalidate", ids: [], kind: "updated" }]);
    // A `session` push always carries the map of conversations, empty here.
    expect(sessionFirst).toEqual([
      { _tag: "invalidate", ids: [], kind: "updated", conversationIds: {} },
    ]);
    expect(afterWindow).toEqual([{ _tag: "invalidate", ids: ["t1"], kind: "created" }]);
  });
});
