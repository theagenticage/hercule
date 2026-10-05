import { describe, expect, it } from "vitest";
import type { ProviderEvent } from "@hercule/protocol";
import {
  buildSubagentActivity,
  collectSubagentTree,
  computeSubagentAfter,
  createBareSubagent,
  findSubagentsNamedBy,
  stopSubagent,
  toSubagentRecord,
  type StoredSubagent,
} from "./subagents";

const SESSION = "0199e0e7-0000-7000-8000-000000000001";

const base = { eventId: "e", sessionId: SESSION, at: "2026-10-05T10:00:00.000Z" };

const later = "2026-10-05T10:05:00.000Z";

const bare = createBareSubagent(SESSION, "a1", base.at);

/** Applies events to a record in order. */
const applyEvents = (
  record: StoredSubagent,
  events: ReadonlyArray<ProviderEvent>,
): StoredSubagent =>
  events.reduce((current, event) => computeSubagentAfter(current, event), record);

const itemStarted = (kind: "user_message" | "command_execution" | "reasoning", detail: unknown) =>
  ({
    ...base,
    _tag: "item.started",
    subagentId: "a1",
    turnId: "t1",
    itemId: `i-${kind}`,
    kind,
    detail,
  }) as ProviderEvent;

describe("computeSubagentAfter", () => {
  it("fills empty fields from the introduction and never overwrites one", () => {
    const introduced = computeSubagentAfter(bare, {
      ...base,
      _tag: "subagent.started",
      subagentId: "a1",
      parentSubagentId: "p1",
      itemId: "item-1",
      description: "Review the diff",
      agentType: "reviewer",
    });
    expect(introduced).toMatchObject({
      parentSubagentId: "p1",
      itemId: "item-1",
      description: "Review the diff",
      agentType: "reviewer",
    });
    // A resumed process that knows less, or names it otherwise, changes nothing.
    const again = computeSubagentAfter(introduced, {
      ...base,
      _tag: "subagent.started",
      subagentId: "a1",
      description: "Something else",
      agentType: "Explore",
    });
    expect(again).toBe(introduced);
  });

  it("ignores another subagent's events", () => {
    const other = { ...base, _tag: "turn.started", turnId: "t", subagentId: "a2" } as const;
    expect(computeSubagentAfter(bare, other)).toBe(bare);
    expect(computeSubagentAfter(bare, { ...base, _tag: "turn.started", turnId: "t" })).toBe(bare);
  });

  it("runs from its turn's start to its end, with the ending as its status", () => {
    const ended = applyEvents(bare, [
      { ...base, _tag: "turn.started", turnId: "t1", subagentId: "a1", model: "opus" },
      itemStarted("command_execution", { command: "pnpm test\nmore" }),
    ]);
    expect(ended).toMatchObject({
      status: "running",
      model: "opus",
      activity: "Running pnpm test",
    });
    const done = computeSubagentAfter(
      ended,
      {
        ...base,
        at: later,
        _tag: "turn.completed",
        turnId: "t1",
        subagentId: "a1",
        state: "interrupted",
      },
      "All tests pass.\nDetails follow.",
    );
    expect(done).toMatchObject({ status: "stopped", endedAt: later, result: "All tests pass." });
    expect(done.activity).toBeUndefined();
    // A parent that gives it more work sets it running again.
    const again = computeSubagentAfter(done, {
      ...base,
      _tag: "turn.started",
      turnId: "t2",
      subagentId: "a1",
    });
    expect(again).toMatchObject({ status: "running", endedAt: undefined, model: "opus" });
  });

  it("maps each turn ending to a status", () => {
    const end = (state: "completed" | "failed") =>
      computeSubagentAfter(bare, {
        ...base,
        _tag: "turn.completed",
        turnId: "t1",
        subagentId: "a1",
        state,
      }).status;
    expect(end("completed")).toBe("completed");
    expect(end("failed")).toBe("failed");
  });

  it("counts tool calls of every kind and nothing else", () => {
    const counted = applyEvents(bare, [
      itemStarted("command_execution", {}),
      itemStarted("reasoning", {}),
      {
        ...base,
        _tag: "item.started",
        subagentId: "a1",
        turnId: "t",
        itemId: "x",
        kind: "file_change",
      },
      {
        ...base,
        _tag: "item.started",
        subagentId: "a1",
        turnId: "t",
        itemId: "y",
        kind: "tool_call",
      },
      {
        ...base,
        _tag: "item.started",
        subagentId: "a1",
        turnId: "t",
        itemId: "z",
        kind: "web_search",
      },
      {
        ...base,
        _tag: "item.started",
        subagentId: "a1",
        turnId: "t",
        itemId: "w",
        kind: "subagent",
      },
    ]);
    expect(counted.toolCalls).toBe(5);
  });

  it("takes an empty description from the first line of its brief", () => {
    const briefed = computeSubagentAfter(
      bare,
      itemStarted("user_message", { text: "\nFind the flaky test\nin the suite" }),
    );
    expect(briefed.description).toBe("Find the flaky test");
    const named = { ...bare, description: "Given name" };
    expect(
      computeSubagentAfter(named, itemStarted("user_message", { text: "Brief" })).description,
    ).toBe("Given name");
  });

  it("fills an empty itemId from a subagent item that lists it, whoever reported the item", () => {
    const item = {
      ...base,
      _tag: "item.completed",
      turnId: "t",
      itemId: "agent-call",
      kind: "subagent",
      status: "completed",
      detail: { subagentIds: ["a1"] },
    } as const;
    const filled = computeSubagentAfter(bare, item);
    expect(filled.itemId).toBe("agent-call");
    expect(computeSubagentAfter(filled, { ...item, itemId: "later-call" })).toBe(filled);
  });

  it("adds up its own usage across processes", () => {
    const usage = (inputTokens: number) =>
      ({
        ...base,
        _tag: "session.usage.updated",
        subagentId: "a1",
        usage: { inputTokens, outputTokens: 1 },
      }) as const;
    const counted = applyEvents(bare, [
      usage(10),
      usage(20),
      { ...base, _tag: "session.started" },
      usage(5),
    ]);
    expect(counted.usage).toEqual({ inputTokens: 25, outputTokens: 2 });
    // The session's own snapshot is not this subagent's.
    const main = {
      ...base,
      _tag: "session.usage.updated",
      usage: { inputTokens: 3, outputTokens: 1 },
    } as const;
    expect(computeSubagentAfter(bare, main)).toBe(bare);
  });

  it("stops a running subagent when its session's process exits", () => {
    const exited = { ...base, at: later, _tag: "session.exited", reason: "stopped" } as const;
    expect(computeSubagentAfter(bare, exited)).toMatchObject({ status: "stopped", endedAt: later });
    const completed = { ...bare, status: "completed" as const, endedAt: base.at };
    expect(computeSubagentAfter(completed, exited)).toBe(completed);
  });
});

describe("findSubagentsNamedBy", () => {
  it("names the introduced subagent as the owner, not its parent", () => {
    expect(
      findSubagentsNamedBy({
        ...base,
        _tag: "subagent.started",
        subagentId: "a2",
        parentSubagentId: "a1",
      }),
    ).toEqual({ owner: "a2", listed: [] });
  });

  it("names the attributed subagent and the ones a subagent item lists", () => {
    expect(
      findSubagentsNamedBy({
        ...base,
        _tag: "item.started",
        subagentId: "a1",
        turnId: "t",
        itemId: "i",
        kind: "subagent",
        detail: { subagentIds: ["a2", "a3", 7] },
      }),
    ).toEqual({ owner: "a1", listed: ["a2", "a3"] });
    expect(findSubagentsNamedBy({ ...base, _tag: "session.started" })).toEqual({
      owner: undefined,
      listed: [],
    });
  });
});

describe("buildSubagentActivity", () => {
  it("names the item's kind and what it works on", () => {
    expect(buildSubagentActivity("file_change", { path: "src/a.ts" })).toBe("Editing src/a.ts");
    expect(buildSubagentActivity("reasoning", undefined)).toBe("Thinking");
    expect(buildSubagentActivity("command_execution", { command: "x".repeat(500) })).toHaveLength(
      200,
    );
  });
});

describe("stopSubagent", () => {
  it("stops only a running subagent and clears what it was doing", () => {
    const working = { ...bare, activity: "Thinking" };
    expect(stopSubagent(working, later)).toMatchObject({
      status: "stopped",
      endedAt: later,
      activity: undefined,
    });
    const failed = { ...bare, status: "failed" as const, endedAt: base.at };
    expect(stopSubagent(failed, later)).toBe(failed);
  });
});

describe("toSubagentRecord", () => {
  it("leaves out absent fields and the process's usage snapshot", () => {
    const record = toSubagentRecord({
      ...bare,
      usage: { inputTokens: 1, outputTokens: 1 },
      usageProcess: { inputTokens: 1, outputTokens: 1 },
    });
    expect(record).toEqual({
      id: "a1",
      sessionId: SESSION,
      status: "running",
      toolCalls: 0,
      usage: { inputTokens: 1, outputTokens: 1 },
      startedAt: base.at,
    });
  });
});

describe("collectSubagentTree", () => {
  it("returns a subagent and every subagent below it, in any order", () => {
    const records = [
      { id: "c", parentSubagentId: "b" },
      { id: "b", parentSubagentId: "a" },
      { id: "a", parentSubagentId: undefined },
      { id: "x", parentSubagentId: undefined },
    ];
    expect([...collectSubagentTree(records, "a")].sort()).toEqual(["a", "b", "c"]);
    expect([...collectSubagentTree(records, "b")].sort()).toEqual(["b", "c"]);
  });
});
