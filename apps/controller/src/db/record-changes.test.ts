/**
 * Tests the record-changes listener: it keeps only the records a transaction
 * changed, hears a change published by `announce`, and a subscriber sees what
 * is published after it subscribed, in order, without anything waiting.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import { announce } from "./after-commit";
import { RecordChanges, RecordChangesLayer } from "./record-changes";

const run = <A>(effect: Effect.Effect<A, never, RecordChanges | Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(RecordChangesLayer))));

describe("RecordChanges", () => {
  it("keeps the record changes, without counts-only session changes and other kinds", async () => {
    const received = await run(
      Effect.gen(function* () {
        const changes = yield* RecordChanges;
        const subscription = yield* changes.subscribe;
        yield* changes.publish([
          { _tag: "record", topic: "mcpServer", id: "a", kind: "updated" },
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
        return yield* PubSub.takeAll(subscription);
      }),
    );

    expect([...received]).toEqual([
      { topic: "mcpServer", id: "a" },
      { topic: "session", id: "s2" },
    ]);
  });

  it("hears a change announced outside a transaction, and only after it subscribed", async () => {
    const received = await run(
      Effect.gen(function* () {
        const changes = yield* RecordChanges;
        yield* announce({ _tag: "record", topic: "connection", id: "early", kind: "updated" });
        const subscription = yield* changes.subscribe;
        yield* announce({ _tag: "record", topic: "connection", id: "late", kind: "updated" });
        return yield* PubSub.takeAll(subscription);
      }),
    );

    expect([...received]).toEqual([{ topic: "connection", id: "late" }]);
  });
});
