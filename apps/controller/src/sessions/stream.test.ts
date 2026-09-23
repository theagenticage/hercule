/**
 * Unit tests for the fold: which rows a reported event writes, and which
 * status it leaves the session in.
 *
 * These tests cover the rules, not the stored rows, so they run without a
 * database. The stored rows are tested end to end in
 * `sessions.integration.test.ts`, over a real socket.
 */
import { describe, expect, it } from "vitest";
import type { ProviderEvent } from "@hercule/protocol";
import {
  DELTA_FLUSH_BYTES,
  fold,
  computeOpenRequestAfter,
  startTracking,
  type Folded,
  type Tracked,
} from "./stream";

const SESSION = "0199e0e7-0000-7000-8000-000000000001";

const TURN = "turn-1";

const base = { eventId: "e", sessionId: SESSION, at: "2026-09-07T10:00:00.000Z" };

const started: ProviderEvent = { ...base, _tag: "session.started" };

const turnStarted: ProviderEvent = { ...base, _tag: "turn.started", turnId: TURN };

const turnCompleted: ProviderEvent = {
  ...base,
  _tag: "turn.completed",
  turnId: TURN,
  state: "completed",
};

const exited: ProviderEvent = { ...base, _tag: "session.exited", reason: "stopped" };

const buildDelta = (itemId: string, text: string): ProviderEvent => ({
  ...base,
  _tag: "content.delta",
  turnId: TURN,
  itemId,
  streamKind: "assistant_text",
  delta: text,
});

const buildCompletedItem = (itemId: string): ProviderEvent => ({
  ...base,
  _tag: "item.completed",
  turnId: TURN,
  itemId,
  kind: "assistant_message",
  status: "completed",
});

const request = {
  requestId: "r1",
  itemId: "i1",
  kind: "command_approval",
  decisions: ["allow", "deny", "cancel"],
  detail: { command: "ls -la" },
} as const;

const opened: ProviderEvent = { ...base, _tag: "request.opened", request };

const resolved: ProviderEvent = {
  ...base,
  _tag: "request.resolved",
  requestId: "r1",
  decision: "allow",
};

/** Returns the event tags of the rows a fold wrote, in order. */
const listTags = (folded: Folded): ReadonlyArray<string> =>
  folded.rows.map((row) => row.event._tag);

/** Returns the merged text of each delta row a fold wrote. */
const listTexts = (folded: Folded): ReadonlyArray<string> =>
  folded.rows.flatMap((row) => (row.event._tag === "content.delta" ? [row.event.delta] : []));

/** Folds a list of events in order, and fails the test if the fold skips one. */
const applyEvents = (
  events: ReadonlyArray<readonly [number, ProviderEvent]>,
  from: Tracked = startTracking({ lastSeq: 0, base: 0 }),
): { readonly state: Tracked; readonly folds: ReadonlyArray<Folded> } => {
  let state = from;
  const folds: Array<Folded> = [];
  for (const [seq, event] of events) {
    const folded = fold(state, seq, event);
    expect(folded, `seq ${String(seq)} was skipped`).toBeDefined();
    folds.push(folded!);
    state = folded!.next;
  }
  return { state, folds };
};

describe("the session status", () => {
  it("changes on the four status events and on no other event", () => {
    const { folds } = applyEvents([
      [1, started],
      [2, turnStarted],
      [3, buildDelta("i1", "hi")],
      [4, buildCompletedItem("i1")],
      [5, turnCompleted],
      [6, exited],
    ]);

    expect(folds.map((one) => one.status)).toEqual([
      "idle",
      "busy",
      undefined,
      undefined,
      "idle",
      "exited",
    ]);
  });
});

describe("a sequence number already applied", () => {
  it("writes nothing and leaves the state unchanged", () => {
    const { state } = applyEvents([
      [1, started],
      [2, turnStarted],
    ]);

    expect(fold(state, 2, turnStarted)).toBeUndefined();
    expect(fold(state, 1, started)).toBeUndefined();
    expect(state.lastSeq).toBe(2);
  });

  it("is skipped for a delta too", () => {
    const { state } = applyEvents([[1, buildDelta("i1", "one")]]);

    expect(fold(state, 1, buildDelta("i1", "again"))).toBeUndefined();
    // The held text is untouched, so a replayed delta cannot be counted twice.
    const flushed = fold(state, 2, buildCompletedItem("i1"))!;
    expect(listTexts(flushed)).toEqual(["one"]);
  });
});

describe("merging deltas", () => {
  it("holds deltas and writes one row at the item boundary", () => {
    const { folds } = applyEvents([
      [1, buildDelta("i1", "Hel")],
      [2, buildDelta("i1", "lo")],
      [3, buildCompletedItem("i1")],
    ]);

    expect(listTags(folds[0]!)).toEqual([]);
    expect(listTags(folds[1]!)).toEqual([]);
    // The merged text first, then the event that flushed it.
    expect(listTags(folds[2]!)).toEqual(["content.delta", "item.completed"]);
    expect(listTexts(folds[2]!)).toEqual(["Hello"]);
    // The row carries the sequence number of the last delta merged into it.
    expect(folds[2]!.rows[0]?.seq).toBe(2);
  });

  it("keeps two stream kinds on one item apart", () => {
    const { folds } = applyEvents([
      [1, buildDelta("i1", "said")],
      [2, { ...buildDelta("i1", "thought"), streamKind: "reasoning_text" } as ProviderEvent],
      [3, buildCompletedItem("i1")],
    ]);

    expect(listTexts(folds[2]!).toSorted()).toEqual(["said", "thought"]);
  });

  it("flushes only the item that ended, and everything at a turn boundary", () => {
    const { folds } = applyEvents([
      [1, buildDelta("i1", "one")],
      [2, buildDelta("i2", "two")],
      [3, buildCompletedItem("i1")],
      [4, turnCompleted],
    ]);

    expect(listTexts(folds[2]!)).toEqual(["one"]);
    expect(listTexts(folds[3]!)).toEqual(["two"]);
  });

  it("flushes the text still held when the session exits", () => {
    const { folds } = applyEvents([
      [1, buildDelta("i1", "tail")],
      [2, exited],
    ]);

    expect(listTags(folds[1]!)).toEqual(["content.delta", "session.exited"]);
  });

  it("writes a row once the held text reaches the flush size", () => {
    const long = "x".repeat(DELTA_FLUSH_BYTES - 1);
    const { folds, state } = applyEvents([
      [1, buildDelta("i1", long)],
      [2, buildDelta("i1", "yz")],
    ]);

    expect(listTags(folds[0]!)).toEqual([]);
    expect(listTexts(folds[1]!)).toEqual([`${long}yz`]);
    // Nothing is held after the flush, so the next boundary writes no empty row.
    expect(state.buffers.size).toBe(0);
    expect(listTags(fold(state, 3, buildCompletedItem("i1"))!)).toEqual(["item.completed"]);
  });
});

describe("every other event", () => {
  it("is written as its own row, verbatim", () => {
    const usage: ProviderEvent = {
      ...base,
      _tag: "session.usage.updated",
      usage: { inputTokens: 10, outputTokens: 20 },
    };
    const { folds } = applyEvents([[1, usage]]);

    expect(folds[0]!.rows).toEqual([{ seq: 1, at: base.at, event: usage }]);
  });
});

describe("the open request", () => {
  it("is set by the request that opens it", () => {
    expect(computeOpenRequestAfter(opened, null)).toEqual(request);
  });

  it("is cleared by its answer, by the turn completing and by the harness exiting", () => {
    expect(computeOpenRequestAfter(resolved, request)).toBeNull();
    // The question ends with the turn it was asked in, answered or not.
    expect(computeOpenRequestAfter(turnCompleted, request)).toBeNull();
    expect(computeOpenRequestAfter(exited, request)).toBeNull();
  });

  it("stays open when a different request is answered", () => {
    const other: ProviderEvent = { ...resolved, requestId: "r2" };

    expect(computeOpenRequestAfter(other, request)).toBeUndefined();
    expect(computeOpenRequestAfter(resolved, null)).toBeUndefined();
  });

  it("returns no change when there is no open request to clear, so nothing is written", () => {
    // Most turns end like this: no request was open, and a write would make
    // every client watching the session refetch for no change.
    expect(computeOpenRequestAfter(turnCompleted, null)).toBeUndefined();
    expect(computeOpenRequestAfter(exited, null)).toBeUndefined();
  });

  it("is not changed by any other event", () => {
    for (const event of [started, turnStarted, buildDelta("i1", "hi"), buildCompletedItem("i1")]) {
      expect(computeOpenRequestAfter(event, request), event._tag).toBeUndefined();
    }
  });
});
