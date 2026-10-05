/**
 * Tests the pace at which record changes reach subscribers. Most changes are
 * collected for 50 ms and sent together. A subagent's record, and a session
 * record whose only change is its Token Usage, change with almost every event
 * an agent reports, so those are collected for a whole second instead.
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
        const queue = yield* topics.subscribe("subagent");
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

  it("sends a session change caused by usage alone a second later, and any other at once", async () => {
    const [afterShortWindow, afterLongWindow] = await run(
      Effect.gen(function* () {
        const topics = yield* LiveTopics;
        const queue = yield* topics.subscribe("session");
        yield* topics.publish([
          { _tag: "record", topic: "session", id: "usage", kind: "updated", usageOnly: true },
          { _tag: "record", topic: "session", id: "status", kind: "updated" },
        ]);
        yield* advance(COALESCE_WINDOW_MS);
        const early = yield* Queue.clear(queue);
        yield* advance(SLOW_COALESCE_WINDOW_MS);
        return [early, yield* Queue.clear(queue)] as const;
      }),
    );

    expect(afterShortWindow).toEqual([{ _tag: "invalidate", ids: ["status"], kind: "updated" }]);
    expect(afterLongWindow).toEqual([{ _tag: "invalidate", ids: ["usage"], kind: "updated" }]);
  });
});
