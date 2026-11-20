/**
 * Tests the record-changes listener: a subscriber gets only the records of the
 * topics it asked for, without counts-only session changes and other kinds,
 * and sees only what is published after it subscribed. That `announce` reaches
 * it is tested with the one `AfterCommit` that feeds it (`live/topics.test.ts`).
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import { RecordChanges, RecordChangesLayer } from "./record-changes";

const run = <A>(effect: Effect.Effect<A, never, RecordChanges | Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(RecordChangesLayer))));

describe("RecordChanges", () => {
  it("keeps the record changes of the subscribed topics, without counts-only session changes and other kinds", async () => {
    const received = await run(
      Effect.gen(function* () {
        const changes = yield* RecordChanges;
        const queue = yield* changes.subscribe(["mcpServer", "session"]);
        yield* changes.publish([
          { _tag: "record", topic: "mcpServer", id: "a", kind: "updated" },
          { _tag: "record", topic: "connection", id: "c", kind: "updated" },
          {
            _tag: "record",
            topic: "session",
            id: "s1",
            conversationId: null,
            kind: "updated",
            countsOnly: true,
          },
          {
            _tag: "record",
            topic: "session",
            id: "s2",
            conversationId: null,
            kind: "updated",
          },
          { _tag: "event" },
          { _tag: "transcript", sessionId: "s2" },
        ]);
        return yield* Queue.takeAll(queue);
      }),
    );

    expect([...received]).toEqual([
      { topic: "mcpServer", id: "a" },
      { topic: "session", id: "s2" },
    ]);
  });
});
