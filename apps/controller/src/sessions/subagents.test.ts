import { describe, expect, it } from "vitest";
import type { ProviderEvent } from "@hercule/protocol";
import {
  buildSubagentActivity,
  collectSubagentTree,
  computeSubagentAfter,
  computeSubagentsAfter,
  createBareSubagent,
  findSubagentsNamedBy,
  findSubagentsToRead,
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
      { lastAssistantText: "All tests pass.\nDetails follow." },
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

  it("takes an empty description from the first line of its first turn's brief", () => {
    const brief = itemStarted("user_message", { text: "\nFind the flaky test\nin the suite" });
    const briefed = computeSubagentAfter(bare, brief, { inFirstTurn: true });
    expect(briefed.description).toBe("Find the flaky test");
    const named = { ...bare, description: "Given name" };
    expect(
      computeSubagentAfter(named, itemStarted("user_message", { text: "Brief" }), {
        inFirstTurn: true,
      }).description,
    ).toBe("Given name");
  });

  it("never takes its description from a later turn's message", () => {
    const followUp = itemStarted("user_message", { text: "Now also fix the lint" });
    expect(computeSubagentAfter(bare, followUp, { inFirstTurn: false }).description).toBe(
      undefined,
    );
    expect(computeSubagentAfter(bare, followUp).description).toBe(undefined);
  });

  it("cuts every text the harness or the parent wrote to one short line", () => {
    const hostile = `# Heading\n\`\`\`\n${"x".repeat(300)}`;
    const introduced = computeSubagentAfter(bare, {
      ...base,
      _tag: "subagent.started",
      subagentId: "a1",
      description: "Fix [it](https://evil.example)\n# Injected",
      agentType: `${"t".repeat(300)}\nmore`,
    });
    expect(introduced.description).toBe("Fix [it](https://evil.example)");
    expect(introduced.agentType).toHaveLength(200);
    const modelled = computeSubagentAfter(bare, {
      ...base,
      _tag: "turn.started",
      turnId: "t1",
      subagentId: "a1",
      model: hostile,
    });
    expect(modelled.model).toBe("# Heading");
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

  it("keeps the latest native usage report through a process exit and a restart", () => {
    const report = { source: "test.provider", payload: { native: [100, 80, 3], label: "opaque" } };
    const event = {
      ...base,
      _tag: "session.usage.updated",
      subagentId: "a1",
      usage: { inputTokens: 20, outputTokens: 3 },
      raw: report,
    } as const;
    const counted = computeSubagentAfter(bare, event);
    expect(counted).toMatchObject({ lastUsageReport: report, usage: event.usage });
    const stopped = stopSubagent(counted, later, undefined);
    expect(stopped.lastUsageReport).toEqual(report);
    const restarted = computeSubagentAfter(stopped, { ...base, _tag: "session.started" });
    expect(restarted.lastUsageReport).toEqual(report);
    expect(restarted.usageProcess).toBeUndefined();
    const resetReport = { source: report.source, payload: { native: [0, 0, 0] } };
    expect(computeSubagentAfter(restarted, { ...event, raw: resetReport }).lastUsageReport).toEqual(
      resetReport,
    );
    expect(
      computeSubagentAfter(counted, {
        ...base,
        _tag: "session.usage.updated",
        subagentId: "a1",
        usage: event.usage,
      }).lastUsageReport,
    ).toBeUndefined();
  });

  it("leaves a session's exit to the cleanup that stops running subagents", () => {
    const exited = { ...base, at: later, _tag: "session.exited", reason: "stopped" } as const;
    expect(computeSubagentAfter(bare, exited)).toBe(bare);
  });
});

describe("findSubagentsToRead", () => {
  it("reads no subagent for the session's own agent's events", () => {
    const delta = {
      ...base,
      _tag: "content.delta",
      turnId: "t",
      itemId: "i",
      streamKind: "assistant_text",
      delta: "Hello",
    } as const;
    expect(findSubagentsToRead(delta)).toEqual([]);
    expect(findSubagentsToRead({ ...base, _tag: "turn.started", turnId: "t" })).toEqual([]);
    expect(findSubagentsToRead({ ...base, _tag: "session.exited", reason: "stopped" })).toEqual([]);
  });

  it("reads the subagents an event names, and every one when a process starts", () => {
    expect(
      findSubagentsToRead({
        ...base,
        _tag: "item.started",
        subagentId: "a1",
        turnId: "t",
        itemId: "i",
        kind: "subagent",
        detail: { subagentIds: ["a2"] },
      }),
    ).toEqual(["a1", "a2"]);
    expect(findSubagentsToRead({ ...base, _tag: "session.started" })).toBe("all");
  });
});

describe("computeSubagentsAfter", () => {
  const delta = {
    ...base,
    _tag: "content.delta",
    subagentId: "a1",
    turnId: "t",
    itemId: "i",
    streamKind: "assistant_text",
    delta: "Hi",
  } as const;

  it("creates a bare record for a subagent it has no record of", () => {
    expect(computeSubagentsAfter(SESSION, delta, new Map())).toEqual([bare]);
  });

  it("keeps the spawn link when the parent's item comes before the introduction", () => {
    const call = {
      ...base,
      _tag: "item.started",
      turnId: "t",
      itemId: "agent-call",
      kind: "subagent",
      detail: { subagentIds: ["a1"] },
    } as const;
    const [listed] = computeSubagentsAfter(SESSION, call, new Map());
    expect(listed).toEqual({ ...bare, itemId: "agent-call" });
    const [introduced] = computeSubagentsAfter(
      SESSION,
      { ...base, at: later, _tag: "subagent.started", subagentId: "a1", description: "Fix it" },
      new Map([["a1", listed!]]),
    );
    expect(introduced).toMatchObject({
      itemId: "agent-call",
      startedAt: base.at,
      description: "Fix it",
    });
    const relisted = { ...call, at: later, itemId: "send-message" };
    expect(computeSubagentsAfter(SESSION, relisted, new Map([["a1", introduced!]]))).toEqual([]);
  });

  it("returns only the records the event changed", () => {
    expect(computeSubagentsAfter(SESSION, delta, new Map([["a1", bare]]))).toEqual([]);
    const started = { ...base, _tag: "session.started" } as const;
    const counted = { ...bare, usageProcess: { inputTokens: 1, outputTokens: 1 } };
    const idle = { ...bare, id: "a2" };
    expect(
      computeSubagentsAfter(
        SESSION,
        started,
        new Map<string, StoredSubagent>([
          ["a1", counted],
          ["a2", idle],
        ]),
      ),
    ).toEqual([{ ...counted, usageProcess: undefined }]);
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
  it("names the target a Claude item keeps under detail.input", () => {
    expect(
      buildSubagentActivity("command_execution", { name: "Bash", input: { command: "npm test" } }),
    ).toBe("Running npm test");
    expect(
      buildSubagentActivity("file_change", { name: "Edit", input: { file_path: "src/a.ts" } }),
    ).toBe("Editing src/a.ts");
    expect(
      buildSubagentActivity("subagent", {
        name: "Agent",
        input: { description: "Read the schema" },
      }),
    ).toBe("Delegating: Read the schema");
  });

  it("names the item's kind and what it works on", () => {
    expect(buildSubagentActivity("file_change", { path: "src/a.ts" })).toBe("Editing src/a.ts");
    expect(buildSubagentActivity("reasoning", undefined)).toBe("Thinking");
    expect(buildSubagentActivity("tool_call", { name: "Read" })).toBe("Using Read");
    expect(buildSubagentActivity("web_search", { description: "effect 4 schema" })).toBe(
      "Searching effect 4 schema",
    );
    expect(buildSubagentActivity("command_execution", { command: "x".repeat(500) })).toHaveLength(
      200,
    );
  });

  it("names a delegation by its task, never by the delegating tool", () => {
    expect(
      buildSubagentActivity("subagent", { name: "Agent", description: "Chase the flaky test" }),
    ).toBe("Delegating: Chase the flaky test");
    expect(buildSubagentActivity("subagent", { name: "spawn_agent" })).toBe("Delegating");
  });
});

describe("stopSubagent", () => {
  const working = { ...bare, activity: "Thinking", result: "Found it." };

  it("stops a running subagent, clears what it was doing and takes its last message as the result", () => {
    expect(stopSubagent(working, later, "\nFixed it.\nDetails follow.")).toMatchObject({
      status: "stopped",
      endedAt: later,
      activity: undefined,
      result: "Fixed it.",
    });
  });

  it("keeps the old result when the cut-off turn wrote no message", () => {
    expect(stopSubagent(working, later, undefined).result).toBe("Found it.");
    expect(stopSubagent(working, later, "  ").result).toBe("Found it.");
  });

  it("leaves a subagent that is no longer running unchanged", () => {
    const failed = { ...bare, status: "failed" as const, endedAt: base.at };
    expect(stopSubagent(failed, later, "Too late.")).toBe(failed);
  });
});

describe("toSubagentRecord", () => {
  it("leaves out absent fields and the process's usage snapshot", () => {
    const record = toSubagentRecord({
      ...bare,
      usage: { inputTokens: 1, outputTokens: 1 },
      usageProcess: { inputTokens: 1, outputTokens: 1 },
      lastUsageReport: { source: "test.provider", payload: { secretNativeDetail: "not public" } },
    });
    expect(record).toEqual({
      id: "a1",
      sessionId: SESSION,
      status: "running",
      toolCalls: 0,
      usage: { inputTokens: 1, outputTokens: 1 },
      usageReport: { status: "complete", counts: { inputTokens: 1, outputTokens: 1 } },
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
