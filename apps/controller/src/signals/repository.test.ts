/**
 * Tests the pending raises of the signal repository against a migrated
 * in-memory database: the outbox between the event router, which records a
 * raise, and the step after the commit, which writes the signal. Also tests
 * the record of the latest end on a thread, which keeps an older event routed
 * again from raising its signal once more, and the open signals of a
 * Connection as an event source reads them.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { Signal } from "@hercule/contract";
import { uuidFromString } from "../db";
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
    const { deleted, deletedAgain, afterOne, afterThread } = await run(
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
        const deleted = yield* signals.deleteRaise(1, KIND);
        const deletedAgain = yield* signals.deleteRaise(1, KIND);
        const afterOne = yield* listRaiseKeys;
        yield* signals.deleteRaisesOnThreadBefore(CONNECTION_ID, "t-1", KIND, 4);
        return { deleted, deletedAgain, afterOne, afterThread: yield* listRaiseKeys };
      }),
    );

    expect([deleted, deletedAgain]).toEqual([true, false]);
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

describe("thread ends", () => {
  it("keeps the latest end of a kind on a thread, and reports only an end after an event", async () => {
    const found = await run(
      Effect.gen(function* () {
        const signals = yield* signalRepository;
        yield* signals.recordThreadEnd(CONNECTION_ID, "t-1", KIND, 8);
        // An older event routed again records an older end, which changes nothing.
        yield* signals.recordThreadEnd(CONNECTION_ID, "t-1", KIND, 5);
        return yield* Effect.all([
          signals.hasThreadEndAfter(CONNECTION_ID, "t-1", KIND, 6),
          signals.hasThreadEndAfter(CONNECTION_ID, "t-1", KIND, 8),
          signals.hasThreadEndAfter(CONNECTION_ID, "t-2", KIND, 6),
          signals.hasThreadEndAfter(CONNECTION_ID, "t-1", "acme/mentioned", 6),
          signals.hasThreadEndAfter(OTHER_CONNECTION_ID, "t-1", KIND, 6),
        ]);
      }),
    );

    expect(found).toEqual([true, false, false, false, false]);
  });
});

/**
 * Writes an event of `connectionId` with the dedup key `dedupKey`, which
 * occurred a minute before `createdAt` by its source's clock, and a signal of
 * `KIND` raised from it on the thread `threadRef` at `createdAt`.
 */
const insertSignalFromEvent = (input: {
  readonly signalId: string;
  readonly connectionId: string;
  readonly threadRef: string;
  readonly dedupKey: string;
  readonly createdAt: string;
  readonly status?: "open" | "resolved";
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const occurredAt = new Date(Date.parse(input.createdAt) - 60_000).toISOString();
    const [event] = yield* sql<{ readonly id: number }>`
      INSERT INTO events (source, connection_id, system, kind, occurred_at, received_at,
                          dedup_key, payload)
      VALUES ('acme', ${uuidFromString(input.connectionId)}, 'acme', 'acme.asked',
              ${occurredAt}, ${input.createdAt}, ${input.dedupKey}, '{}')
      RETURNING id`;
    const signal: Signal = {
      id: input.signalId,
      kind: KIND,
      origin: {
        type: "event",
        eventId: event!.id,
        connectionId: input.connectionId,
        threadRef: input.threadRef,
      },
      title: "Asked",
      priority: "normal",
      blocks: [],
      actions: [],
      match: {},
      status: input.status ?? "open",
      ...(input.status === "resolved"
        ? {
            resolution: {
              kind: "withdrawn",
              outcome: "Replaced",
              actor: "system",
              origin: "core",
              at: input.createdAt,
            },
          }
        : {}),
      createdAt: input.createdAt,
    };
    const signals = yield* signalRepository;
    yield* signals.insert(signal, [event!.id]);
  });

describe("open signals of a Connection", () => {
  it("lists the open signals of the Connection oldest first, each with the dedup key and time of its event", async () => {
    const listed = await run(
      Effect.gen(function* () {
        yield* insertSignalFromEvent({
          signalId: "0199e0e7-0000-7000-8000-00000000a002",
          connectionId: CONNECTION_ID,
          threadRef: "t-2",
          dedupKey: "notification-2",
          createdAt: "2026-10-13T09:02:00.000Z",
        });
        yield* insertSignalFromEvent({
          signalId: "0199e0e7-0000-7000-8000-00000000a001",
          connectionId: CONNECTION_ID,
          threadRef: "t-1",
          dedupKey: "notification-1",
          createdAt: "2026-10-13T09:01:00.000Z",
        });
        yield* insertSignalFromEvent({
          signalId: "0199e0e7-0000-7000-8000-00000000a003",
          connectionId: CONNECTION_ID,
          threadRef: "t-3",
          dedupKey: "notification-3",
          createdAt: "2026-10-13T09:03:00.000Z",
          status: "resolved",
        });
        // The other Connection's event shares a dedup key, which only the
        // Connection makes unique.
        yield* insertSignalFromEvent({
          signalId: "0199e0e7-0000-7000-8000-00000000a004",
          connectionId: OTHER_CONNECTION_ID,
          threadRef: "t-1",
          dedupKey: "notification-1",
          createdAt: "2026-10-13T09:04:00.000Z",
        });
        const signals = yield* signalRepository;
        return yield* signals.listOpenOnConnection(CONNECTION_ID);
      }),
    );

    expect(listed).toEqual([
      {
        kind: KIND,
        threadRef: "t-1",
        event: { dedupKey: "notification-1", occurredAt: "2026-10-13T09:00:00.000Z" },
        raisedAt: "2026-10-13T09:01:00.000Z",
      },
      {
        kind: KIND,
        threadRef: "t-2",
        event: { dedupKey: "notification-2", occurredAt: "2026-10-13T09:01:00.000Z" },
        raisedAt: "2026-10-13T09:02:00.000Z",
      },
    ]);
  });
});
