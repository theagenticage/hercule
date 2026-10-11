/**
 * Tests the pending raises of the signal repository against a migrated
 * in-memory database: the outbox between the event router, which records a
 * raise, and the step after the commit, which writes the signal.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { TestDatabase } from "../db/testing";
import { signalRepository, type PendingRaise } from "./repository";

const CONNECTION_ID = "0199e0e7-0000-7000-8000-00000000c001";
const OTHER_CONNECTION_ID = "0199e0e7-0000-7000-8000-00000000c002";
const KIND = "acme/asked";

/** Builds a pending `yes` raise of `KIND` on the thread `t-1` of `CONNECTION_ID`. */
const buildRaise = (eventId: number, changes: Partial<PendingRaise> = {}): PendingRaise => ({
  eventId,
  kind: KIND,
  decision: "yes",
  connectionId: CONNECTION_ID,
  threadRef: "t-1",
  createdAt: "2026-10-11T12:00:00.000Z",
  ...changes,
});

/** Runs an effect on a fresh database. */
const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, TestDatabase));

/** Returns the event id and kind of every pending raise, in the order they are listed. */
const listRaiseKeys = Effect.map(
  Effect.flatMap(signalRepository, (signals) => signals.listPendingRaises()),
  (raises) => raises.map((raise) => `${raise.eventId} ${raise.kind}`),
);

describe("pending raises", () => {
  it("records one raise per event and kind, lists them oldest event first, and reads them back whole", async () => {
    const { keys, first } = await run(
      Effect.gen(function* () {
        const signals = yield* signalRepository;
        yield* signals.insertRaise(buildRaise(9));
        yield* signals.insertRaise(buildRaise(4, { decision: "undecided" }));
        // The router routes an event a second time after enrichment.
        yield* signals.insertRaise(buildRaise(4, { decision: "yes" }));
        yield* signals.insertRaise(buildRaise(4, { kind: "acme/mentioned" }));
        const [first] = yield* signals.listPendingRaises();
        return { keys: yield* listRaiseKeys, first };
      }),
    );

    expect(keys).toEqual(["4 acme/asked", "4 acme/mentioned", "9 acme/asked"]);
    expect(first).toEqual(buildRaise(4, { decision: "undecided" }));
  });

  it("deletes one raise, and the raises of a kind on a thread before an event", async () => {
    const { afterOne, afterThread } = await run(
      Effect.gen(function* () {
        const signals = yield* signalRepository;
        for (const raise of [
          buildRaise(1),
          buildRaise(2),
          buildRaise(3),
          buildRaise(4),
          buildRaise(2, { kind: "acme/mentioned" }),
          buildRaise(5, { threadRef: "t-2" }),
          buildRaise(6, { connectionId: OTHER_CONNECTION_ID }),
        ]) {
          yield* signals.insertRaise(raise);
        }
        yield* signals.deleteRaise(1, KIND);
        const afterOne = yield* listRaiseKeys;
        yield* signals.deleteRaisesOnThreadBefore(CONNECTION_ID, "t-1", KIND, 4);
        return { afterOne, afterThread: yield* listRaiseKeys };
      }),
    );

    expect(afterOne).toEqual([
      "2 acme/asked",
      "2 acme/mentioned",
      "3 acme/asked",
      "4 acme/asked",
      "5 acme/asked",
      "6 acme/asked",
    ]);
    // Event 4 is the ending event's own position, so its raise stays.
    expect(afterThread).toEqual([
      "2 acme/mentioned",
      "4 acme/asked",
      "5 acme/asked",
      "6 acme/asked",
    ]);
  });
});
