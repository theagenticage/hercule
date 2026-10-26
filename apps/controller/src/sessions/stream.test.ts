/**
 * Unit tests for the fold: which rows a reported event writes, and how the
 * open Requests change.
 *
 * These tests cover the rules, not the stored rows, so they run without a
 * database. The stored rows are tested end to end in
 * `sessions.integration.test.ts`, over a real socket.
 */
import { describe, expect, it } from "vitest";
import type { ProviderEvent } from "@hercule/protocol";
import type { SessionRequest } from "@hercule/contract";
import {
  DELTA_FLUSH_BYTES,
  attributeEvent,
  computeOpenRequestsAfter,
  fold,
  startTracking,
  type Folded,
  type RequestEvent,
  type Tracked,
} from "./stream";

const SESSION = "0199e0e7-0000-7000-8000-000000000001";

const TURN = "turn-1";

const base = { eventId: "e", sessionId: SESSION, at: "2026-09-07T10:00:00.000Z" };

const turnCompleted: RequestEvent = {
  ...base,
  _tag: "turn.completed",
  turnId: TURN,
  state: "completed",
};

const exited: RequestEvent = { ...base, _tag: "session.exited", reason: "stopped" };

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

const opened: RequestEvent = { ...base, _tag: "request.opened", request };

const resolved: RequestEvent = {
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

describe("merging deltas", () => {
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

  it("ends a row written at the flush size on a word break, and keeps the rest held", () => {
    const words = "word ".repeat(DELTA_FLUSH_BYTES / 5 - 2);
    const { folds, state } = applyEvents([
      [1, buildDelta("i1", `${words}datab`)],
      [2, buildDelta("i1", "ase migrated")],
      [3, buildCompletedItem("i1")],
    ]);

    // The first row holds only the first delta's words, so it takes that
    // delta's sequence number, and the word split across the deltas is
    // written whole in the next row.
    expect(folds[1]!.rows).toMatchObject([{ seq: 1, event: { delta: words } }]);
    expect(state.buffers.size).toBe(0);
    expect(folds[2]!.rows).toMatchObject([
      { seq: 2, event: { delta: "database migrated" } },
      { seq: 3, event: { _tag: "item.completed" } },
    ]);
  });

  it("writes a delta that alone reaches the flush size at once, after the words held before it", () => {
    const huge = "y".repeat(DELTA_FLUSH_BYTES * 3);
    const { folds, state } = applyEvents([
      [1, buildDelta("i1", "held words")],
      [2, buildDelta("i1", huge)],
    ]);

    expect(folds[1]!.rows).toMatchObject([
      { seq: 1, event: { delta: "held " } },
      { seq: 2, event: { delta: `words${huge}` } },
    ]);
    expect(state.buffers.size).toBe(0);
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

describe("attributeEvent", () => {
  it("stores a subagent's introduction under the agent that started it", () => {
    const introduced = { ...base, _tag: "subagent.started", subagentId: "a2" } as const;
    expect(attributeEvent(introduced)).toBeUndefined();
    expect(attributeEvent({ ...introduced, parentSubagentId: "a1" })).toBe("a1");
  });
});

describe("a subagent's events", () => {
  const ofSubagent = <E extends ProviderEvent>(event: E): E => ({ ...event, subagentId: "a1" });

  it("are held apart from the session's own deltas on the same item id", () => {
    const { folds, state } = applyEvents([
      [1, buildDelta("i1", "main ")],
      [2, ofSubagent(buildDelta("i1", "sub "))],
      [3, buildDelta("i1", "again")],
    ]);
    expect(folds.every((folded) => folded.rows.length === 0)).toBe(true);
    expect(state.buffers.size).toBe(2);
  });

  it("flush only on their own agent's item and turn ends", () => {
    const { folds, state } = applyEvents([
      [1, buildDelta("i1", "main")],
      [2, ofSubagent(buildDelta("i1", "sub"))],
      [3, ofSubagent(buildCompletedItem("i1"))],
      [4, ofSubagent(buildDelta("i2", "more"))],
      [5, turnCompleted],
    ]);
    expect(listTexts(folds[2]!)).toEqual(["sub"]);
    // The session's own turn ends, so its text is flushed; the subagent's
    // turn is still running and keeps its held text.
    expect(listTexts(folds[4]!)).toEqual(["main"]);
    expect(state.buffers.size).toBe(1);
    expect(listTexts(fold(state, 6, exited)!)).toEqual(["more"]);
  });
});

describe("the open Requests", () => {
  const second = { ...request, requestId: "r2" } as const;
  const main: SessionRequest = request;
  const fromSubagent: SessionRequest = { ...second, subagentId: "a1" };

  it("ignore a Request reported again with an id already open", () => {
    const open = [main];
    expect(computeOpenRequestsAfter(opened, open)).toBe(open);
  });

  it("lose only the Requests of the agent whose turn ended", () => {
    const open = [main, fromSubagent];
    expect(computeOpenRequestsAfter(turnCompleted, open)).toEqual([fromSubagent]);
    expect(computeOpenRequestsAfter({ ...turnCompleted, subagentId: "a1" }, open)).toEqual([main]);
    expect(computeOpenRequestsAfter({ ...turnCompleted, subagentId: "a9" }, open)).toBe(open);
  });

  it("keep an async question when its agent's turn ends, but not a blocking one", () => {
    const question = {
      requestId: "q1",
      itemId: "i2",
      kind: "question",
      detail: {
        questions: [{ question: "Ship it?", header: "Ship", options: [], multiSelect: false }],
      },
    } as const;
    const async: SessionRequest = { ...question, async: true };
    const blocking: SessionRequest = { ...question, requestId: "q2" };
    expect(computeOpenRequestsAfter(turnCompleted, [main, async, blocking])).toEqual([async]);
    expect(computeOpenRequestsAfter(exited, [async])).toEqual([]);
    expect(computeOpenRequestsAfter({ ...resolved, requestId: "q1" }, [async])).toEqual([]);
  });

  it("are all closed when the harness exits", () => {
    expect(computeOpenRequestsAfter(exited, [main, fromSubagent])).toEqual([]);
  });

  it("return the same list when nothing changed, so nothing is written", () => {
    // Most turns end like this: no Request was open, and a write would make
    // every client watching the session refetch for no change.
    const empty: ReadonlyArray<SessionRequest> = [];
    expect(computeOpenRequestsAfter(turnCompleted, empty)).toBe(empty);
    expect(computeOpenRequestsAfter(exited, empty)).toBe(empty);
    expect(computeOpenRequestsAfter(resolved, empty)).toBe(empty);
  });
});
