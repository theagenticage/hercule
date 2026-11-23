/**
 * Tests the record-changes listener: a subscriber gets only the records of the
 * topics it asked for, without counts-only session changes and other kinds,
 * each record once however often it changed, and sees only what is published
 * after it subscribed. That `announce` reaches it is tested with the one
 * `AfterCommit` that feeds it (`live/topics.test.ts`).
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { RecordChanges, RecordChangesLayer } from "./record-changes";

const run = <A>(effect: Effect.Effect<A, never, RecordChanges | Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect.pipe(Effect.provide(RecordChangesLayer))));

describe("RecordChanges", () => {
  it("keeps the record changes and profile grant changes of the subscribed topics, without counts-only session changes and other kinds", async () => {
    const received = await run(
      Effect.gen(function* () {
        const changes = yield* RecordChanges;
        const subscription = yield* changes.subscribe(["mcpServer", "session", "profileGrants"]);
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
          { _tag: "profileGrants", profileId: "p1" },
          { _tag: "event" },
          { _tag: "transcript", sessionId: "s2" },
        ]);
        return yield* subscription.takePending;
      }),
    );

    expect([...received]).toEqual([
      { topic: "mcpServer", id: "a" },
      { topic: "session", id: "s2" },
      { topic: "profileGrants", id: "p1" },
    ]);
  });

  it("returns a record that changed many times once, and then waits for the next change", async () => {
    const { first, second } = await run(
      Effect.gen(function* () {
        const changes = yield* RecordChanges;
        const subscription = yield* changes.subscribe(["mcpServer"]);
        const change = { _tag: "record", topic: "mcpServer", id: "a", kind: "updated" } as const;
        yield* changes.publish([change, change]);
        yield* changes.publish([change]);
        const first = yield* subscription.takePending;
        yield* changes.publish([{ ...change, id: "b" }]);
        return { first, second: yield* subscription.takePending };
      }),
    );

    expect([...first]).toEqual([{ topic: "mcpServer", id: "a" }]);
    expect([...second]).toEqual([{ topic: "mcpServer", id: "b" }]);
  });
});
