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
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";
import type { Delta, LiveMessage, TranscriptRow } from "@hercule/contract";
import { mintUuid, uuidFromString, uuidToString } from "../db";
import { inTransaction, TestDatabase } from "../db/testing";
import { sessionRepository } from "../sessions";
import { subscribeSkippingFirstPush } from "./testing";
import {
  COALESCE_WINDOW_MS,
  LiveTopics,
  LiveTopicsLayer,
  SLOW_COALESCE_WINDOW_MS,
  type LiveFailure,
} from "./topics";

const SESSION = "0199e0e7-0000-7000-8000-000000000001";

/**
 * Runs a test with the Live Topics and the database they read, which a test
 * can write to as well, for example to add log entries for a subscription to
 * follow.
 */
const run = <A, E>(
  effect: Effect.Effect<A, E, LiveTopics | SqlClient.SqlClient | Scope.Scope>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(
      Effect.provide(Layer.provideMerge(LiveTopicsLayer, TestDatabase)),
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
            countsOnly: true,
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

const MIB = 1024 * 1024;

const AT = "2026-10-29T10:00:00.000Z";

/** Writes a session with an empty transcript and returns its id. */
const insertSession = Effect.gen(function* () {
  const sessions = yield* sessionRepository;
  const sessionId = uuidToString(mintUuid());
  yield* inTransaction(
    sessions.insert({
      id: sessionId,
      title: "a session",
      role: undefined,
      permissionProfileId: uuidToString(mintUuid()),
      agentId: undefined,
      conversationId: undefined,
      step: undefined,
      providerAccountId: uuidToString(mintUuid()),
      harnessId: "test/test",
      runnerId: uuidToString(mintUuid()),
      requestedAccessMode: "approval-required",
      accessMode: "approval-required",
      workspaceId: null,
      projectId: undefined,
      checkoutBranch: undefined,
      githubConnectionId: undefined,
      spec: "{}",
      modelSelection: { model: "clever", options: {} },
      parentSessionId: undefined,
      createdBy: "user",
      at: AT,
    }),
  );
  return sessionId;
});

/**
 * Appends a transcript row whose delta is `size` copies of `character`, so
 * its stored JSON is a little longer than that. `seq` is the runner's sequence
 * number and must be new in the session. The row is written without telling
 * the subscribers.
 */
const insertTranscriptRow = (sessionId: string, seq: number, size: number, character = "x") =>
  Effect.gen(function* () {
    const sessions = yield* sessionRepository;
    yield* inTransaction(
      sessions.append(sessionId, {
        seq,
        at: AT,
        event: {
          eventId: uuidToString(mintUuid()),
          sessionId,
          at: AT,
          _tag: "content.delta",
          turnId: "t1",
          itemId: "i1",
          streamKind: "assistant_text",
          delta: character.repeat(size),
        },
      }),
    );
  });

/** Tells the subscribers to a session's transcript that it grew. */
const announceTranscript = (sessionId: string) =>
  Effect.gen(function* () {
    const topics = yield* LiveTopics;
    yield* topics.publish([{ _tag: "transcript", sessionId }]);
  });

/** Appends a transcript row and tells the subscribers, as the controller does on a commit. */
const appendTranscriptRow = (sessionId: string, seq: number, size: number, character = "x") =>
  Effect.andThen(
    insertTranscriptRow(sessionId, seq, size, character),
    announceTranscript(sessionId),
  );

/**
 * Waits up to five seconds until at least `count` messages wait in the queue,
 * and returns whether they do. A subscription fills its queue from a fiber of
 * its own, so a test cannot know when a message arrives except by waiting.
 */
const untilWaiting = (queue: Queue.Dequeue<LiveMessage, unknown>, count: number) =>
  Effect.promise(async () => {
    const deadline = Date.now() + 5000;
    while (Queue.sizeUnsafe(queue) < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return Queue.sizeUnsafe(queue) >= count;
  });

/** Takes every waiting message, as a client that has read its stream does. */
const readAll = (queue: Queue.Dequeue<LiveMessage, LiveFailure>) => Queue.takeAll(queue);

/** Reads the queue until the subscription ends, and returns the error it ended with. */
const readUntilEnd = (queue: Queue.Dequeue<LiveMessage, LiveFailure>) =>
  Effect.flip(Effect.forever(Queue.take(queue)));

const asDelta = (message: LiveMessage | undefined): Delta => {
  if (message?._tag !== "delta") throw new Error("expected a delta");
  return message;
};

const positionsOf = (delta: Delta): ReadonlyArray<number> =>
  delta.items.map((item) => (item as TranscriptRow).position);

describe("the memory a log subscription may hold for a client that does not read", () => {
  it("ends the subscription when the waiting messages add up to more than 8 MiB, and not before", async () => {
    const [waitingAtSixMiB, stillSubscribed, failure] = await run(
      Effect.gen(function* () {
        const topics = yield* LiveTopics;
        const sessionId = yield* insertSession;
        const queue = yield* topics.followSession(sessionId, undefined, undefined);
        yield* untilWaiting(queue, 1);

        yield* appendTranscriptRow(sessionId, 1, 3 * MIB);
        yield* appendTranscriptRow(sessionId, 2, 3 * MIB);
        const waitingAtSixMiB = yield* untilWaiting(queue, 3);
        const stillSubscribed = yield* topics.subscriberCount(`session:${sessionId}:stream`);

        yield* appendTranscriptRow(sessionId, 3, 3 * MIB);
        return [waitingAtSixMiB, stillSubscribed, yield* readUntilEnd(queue)] as const;
      }),
    );

    expect(waitingAtSixMiB).toBe(true);
    expect(stillSubscribed).toBe(1);
    expect(failure).toMatchObject({ error: { code: "cap_exceeded", details: { cap: 8 * MIB } } });
    const count = (failure as { error: { details: { count: number } } }).error.details.count;
    expect(count).toBeGreaterThan(8 * MIB);
    expect(count).toBeLessThan(9 * MIB + 1024);
  });

  it("weighs a transcript row in bytes, not in characters", async () => {
    // "€" is one character and three bytes. Two rows of 1.5 Mi characters are
    // 3 Mi characters, under the limit, but 9 MiB of text.
    const failure = await run(
      Effect.gen(function* () {
        const topics = yield* LiveTopics;
        const sessionId = yield* insertSession;
        const queue = yield* topics.followSession(sessionId, undefined, undefined);
        yield* untilWaiting(queue, 1);

        yield* appendTranscriptRow(sessionId, 1, 1.5 * MIB, "€");
        yield* untilWaiting(queue, 2);
        yield* appendTranscriptRow(sessionId, 2, 1.5 * MIB, "€");
        return yield* readUntilEnd(queue);
      }),
    );

    expect(failure).toMatchObject({ error: { code: "cap_exceeded", details: { cap: 8 * MIB } } });
  });

  it("weighs a token tap by the bytes of its delta text", async () => {
    // Two deltas of 2 Mi characters, "€" being three bytes: 4 Mi characters
    // wait, which is under the limit, but they are 12 MiB.
    const [accepted, failure] = await run(
      Effect.gen(function* () {
        const topics = yield* LiveTopics;
        const sessionId = yield* insertSession;
        const queue = yield* topics.tapSession(sessionId, undefined);
        const tap = {
          _tag: "tap",
          sessionId,
          item: {
            turnId: "t1",
            itemId: "i1",
            streamKind: "assistant_text",
            delta: "€".repeat(2 * MIB),
          },
        } as const;

        yield* topics.publish([tap]);
        const accepted = Queue.sizeUnsafe(queue);
        yield* topics.publish([tap]);
        return [accepted, yield* readUntilEnd(queue)] as const;
      }),
    );

    expect(accepted).toBe(1);
    expect(failure).toMatchObject({ error: { code: "cap_exceeded", details: { cap: 8 * MIB } } });
  });

  it("weighs an event by its stored payload and raw text", async () => {
    const failure = await run(
      Effect.gen(function* () {
        const topics = yield* LiveTopics;
        const sql = yield* SqlClient.SqlClient;
        const queue = yield* topics.follow(undefined);
        yield* untilWaiting(queue, 1);

        const insertEvent = (key: string) =>
          Effect.andThen(
            inTransaction(
              sql`INSERT INTO events (source, system, kind, occurred_at, received_at, dedup_key,
                                      payload, raw)
                  VALUES ('acme', 'acme', 'acme.thing.opened', ${AT}, ${AT}, ${key}, '{}',
                          ${JSON.stringify({ pad: "x".repeat(5 * MIB) })})`,
            ),
            topics.publish([{ _tag: "event" }]),
          );
        yield* insertEvent("first");
        yield* untilWaiting(queue, 2);
        yield* insertEvent("second");
        return yield* readUntilEnd(queue);
      }),
    );

    expect(failure).toMatchObject({ error: { code: "cap_exceeded", details: { cap: 8 * MIB } } });
  });

  it("accepts one message bigger than 8 MiB into an empty queue, and the next one after it is read", async () => {
    const [huge, stillSubscribed, next] = await run(
      Effect.gen(function* () {
        const topics = yield* LiveTopics;
        const sessionId = yield* insertSession;
        const queue = yield* topics.followSession(sessionId, undefined, undefined);
        yield* untilWaiting(queue, 1);
        yield* readAll(queue);

        yield* appendTranscriptRow(sessionId, 1, 9 * MIB);
        yield* untilWaiting(queue, 1);
        const stillSubscribed = yield* topics.subscriberCount(`session:${sessionId}:stream`);
        const huge = yield* readAll(queue);

        yield* appendTranscriptRow(sessionId, 2, 10);
        yield* untilWaiting(queue, 1);
        return [huge, stillSubscribed, yield* readAll(queue)] as const;
      }),
    );

    expect(stillSubscribed).toBe(1);
    expect(huge.map(asDelta).map(positionsOf)).toEqual([[1]]);
    expect(next.map(asDelta).map(positionsOf)).toEqual([[2]]);
  });

  it("frees the bytes of the messages the client has read", async () => {
    const [afterRead, subscribers] = await run(
      Effect.gen(function* () {
        const topics = yield* LiveTopics;
        const sessionId = yield* insertSession;
        const queue = yield* topics.followSession(sessionId, undefined, undefined);
        yield* untilWaiting(queue, 1);

        // Six MiB wait, which is under the limit. The client reads them. Six
        // more must wait without ending the subscription: counting the first
        // six again would make twelve.
        yield* appendTranscriptRow(sessionId, 1, 3 * MIB);
        yield* appendTranscriptRow(sessionId, 2, 3 * MIB);
        yield* untilWaiting(queue, 3);
        yield* readAll(queue);

        yield* appendTranscriptRow(sessionId, 3, 3 * MIB);
        yield* untilWaiting(queue, 1);
        yield* appendTranscriptRow(sessionId, 4, 3 * MIB);
        const arrived = yield* untilWaiting(queue, 2);
        return [arrived, yield* topics.subscriberCount(`session:${sessionId}:stream`)] as const;
      }),
    );

    expect(afterRead).toBe(true);
    expect(subscribers).toBe(1);
  });
});

describe("the first message of a log subscription", () => {
  it("stops at about 1 MiB, and the rows left over follow without another write", async () => {
    const messages = await run(
      Effect.gen(function* () {
        const topics = yield* LiveTopics;
        const sessionId = yield* insertSession;
        for (let seq = 1; seq <= 5; seq++) {
          yield* insertTranscriptRow(sessionId, seq, 400 * 1024);
        }
        // No announcement follows: the rest must come without a doorbell.
        const queue = yield* topics.followSession(sessionId, undefined, 0);
        yield* untilWaiting(queue, 4);
        return yield* readAll(queue);
      }),
    );

    const deltas = messages.map(asDelta);
    expect(deltas.map(positionsOf)).toEqual([[1, 2], [3], [4], [5]]);
    expect(deltas.map((delta) => delta.cursor)).toEqual(["2", "3", "4", "5"]);
  });

  it("carries a stored event of a type this build does not know as an unknown event", async () => {
    const messages = await run(
      Effect.gen(function* () {
        const topics = yield* LiveTopics;
        const sql = yield* SqlClient.SqlClient;
        const sessionId = yield* insertSession;
        // What a later build leaves behind in the transcript, stored natively.
        const stored = {
          _tag: "turn.paused",
          eventId: uuidToString(mintUuid()),
          sessionId,
          at: AT,
          turnId: "t1",
        };
        yield* inTransaction(
          sql`INSERT INTO session_stream (session_id, position, runner_seq, at, event)
              VALUES (${uuidFromString(sessionId)}, 1, 1, ${AT}, ${JSON.stringify(stored)})`,
        );
        const queue = yield* topics.followSession(sessionId, undefined, 0);
        yield* untilWaiting(queue, 1);
        return yield* readAll(queue);
      }),
    );

    const [row] = asDelta(messages[0]).items as ReadonlyArray<TranscriptRow>;
    expect(row?.event).toMatchObject({ _tag: "unknown", originalType: "turn.paused" });
  });

  it("carries a first row bigger than 1 MiB alone", async () => {
    const messages = await run(
      Effect.gen(function* () {
        const topics = yield* LiveTopics;
        const sessionId = yield* insertSession;
        yield* insertTranscriptRow(sessionId, 1, 2 * MIB);
        yield* insertTranscriptRow(sessionId, 2, 10);
        const queue = yield* topics.followSession(sessionId, undefined, 0);
        yield* untilWaiting(queue, 2);
        return yield* readAll(queue);
      }),
    );

    expect(messages.map(asDelta).map(positionsOf)).toEqual([[1], [2]]);
  });
});
