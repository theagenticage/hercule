/**
 * Tests the pi normalizer, which turns one line of pi's stdout plus a
 * per-session state into normalized events. Nothing here starts a process.
 *
 * The lines use pi 0.85.1's RPC event shapes, from `docs/rpc.md` and the
 * types behind it: `AgentEvent` in `@earendil-works/pi-agent-core`,
 * `AgentSessionEvent` in `dist/core/agent-session.d.ts`, and the stdout
 * format in `dist/modes/json-event.d.ts`. That format removes the cumulative
 * `partial` snapshot from every `assistantMessageEvent`, and adds the call id
 * and tool name to `toolcall_start`.
 *
 * `buildNormalizingState` builds the state and `normalize(state, line)` takes
 * one raw line, not a parsed one, because a line that is not JSON is one of
 * the cases below. The tests do not check event ids or `at` timestamps.
 */
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  ContextCompactionDetail,
  MAX_FACT_LENGTH,
  MAX_MESSAGE_LENGTH,
  ProviderEvent,
  UnknownItemDetail,
  type SubagentId,
} from "@hercule/protocol";
import { endTurn, normalize, buildNormalizingState, buildSubagentState } from "./normalize";
import { FILE_WRITING_TOOLS, SUBAGENT_TOOL } from "./extension";

const SESSION = "0199e0e7-0000-7000-8000-0000000000ff";
const NATIVE = "0199e0e7-0000-7000-8000-0000000000fe";
const CALL = "call_abc123";

const usage = {
  input: 120,
  output: 8,
  cacheRead: 30,
  cacheWrite: 0,
  totalTokens: 158,
  cost: {
    input: 0.000168,
    output: 0.0000352,
    cacheRead: 0.0000078,
    cacheWrite: 0,
    total: 0.000211,
  },
};

const ZERO = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const buildMessage = (content: ReadonlyArray<Record<string, unknown>>, totals = usage) => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "zai",
  model: "glm-5.3",
  usage: totals,
  stopReason: "stop",
  timestamp: 1789373122124,
});

const buildLine = (event: Record<string, unknown>): string => JSON.stringify(event);

const HOME = "/home/ada";

const buildTestState = () =>
  buildNormalizingState(SESSION, NATIVE, undefined, HOME, () => undefined);

const normalizeEvents = (
  running: ReturnType<typeof buildNormalizingState>,
  events: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<ProviderEvent> => events.flatMap((event) => normalize(running, buildLine(event)));

/** Normalizes a whole sequence of events against a fresh state, the common case. */
const normalizeFromStart = (
  events: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<ProviderEvent> => normalizeEvents(buildTestState(), events);

const listEventTags = (events: ReadonlyArray<ProviderEvent>): ReadonlyArray<string> =>
  events.map((event) => event._tag);

const filterByTag = <Tag extends ProviderEvent["_tag"]>(
  events: ReadonlyArray<ProviderEvent>,
  tag: Tag,
): ReadonlyArray<Extract<ProviderEvent, { _tag: Tag }>> =>
  events.filter((event): event is Extract<ProviderEvent, { _tag: Tag }> => event._tag === tag);

const buildMessageUpdate = (assistantMessageEvent: Record<string, unknown>) => ({
  type: "message_update",
  usage,
  assistantMessageEvent,
});

const TEXT = [{ type: "text", text: "OK" }];

const ANSWERING = [
  { type: "agent_start" },
  { type: "turn_start" },
  { type: "message_start", message: buildMessage([], ZERO) },
  buildMessageUpdate({ type: "text_start", contentIndex: 0 }),
  buildMessageUpdate({ type: "text_delta", contentIndex: 0, delta: "O" }),
  buildMessageUpdate({ type: "text_delta", contentIndex: 0, delta: "K" }),
  buildMessageUpdate({ type: "text_end", contentIndex: 0, content: "OK" }),
  { type: "message_end", message: buildMessage(TEXT) },
  { type: "turn_end", message: buildMessage(TEXT), toolResults: [] },
  { type: "agent_end", messages: [buildMessage(TEXT)], willRetry: false },
  { type: "agent_settled" },
];

const buildToolStart = (toolName: string, args: Record<string, unknown>) => ({
  type: "tool_execution_start",
  toolCallId: CALL,
  toolName,
  args,
});

const buildToolUpdate = (text: string) => ({
  type: "tool_execution_update",
  toolCallId: CALL,
  toolName: "bash",
  args: { command: "echo hello" },
  partialResult: {
    content: [{ type: "text", text }],
    details: { truncation: null, fullOutputPath: null },
  },
});

const buildToolEnd = (isError: boolean) => ({
  type: "tool_execution_end",
  toolCallId: CALL,
  toolName: "bash",
  result: { content: [{ type: "text", text: "hello\n" }], details: {} },
  isError,
});

describe("normalizing a whole pi turn", () => {
  it("reports the turn, the assistant's item, its deltas, and both completions", () => {
    const events = normalizeFromStart(ANSWERING);

    expect(listEventTags(events)).toEqual([
      "turn.started",
      "item.started",
      "content.delta",
      "content.delta",
      "item.completed",
      "session.usage.updated",
      "turn.completed",
    ]);
    expect(filterByTag(events, "item.started")[0]?.kind).toBe("assistant_message");
    expect(filterByTag(events, "content.delta").map((event) => event.delta)).toEqual(["O", "K"]);
    expect(filterByTag(events, "content.delta")[0]?.streamKind).toBe("assistant_text");
    expect(filterByTag(events, "item.completed")[0]?.status).toBe("completed");
  });

  it("puts every event under the id of the turn it opened", () => {
    const events = normalizeFromStart(ANSWERING);

    const turnId = filterByTag(events, "turn.started")[0]?.turnId;
    expect(turnId).toBeDefined();
    for (const event of events) {
      if ("turnId" in event) expect(event.turnId).toBe(turnId);
    }
  });

  it("reports thinking as its own item on its own stream, before the answer", () => {
    const events = normalizeFromStart([
      { type: "agent_start" },
      { type: "message_start", message: buildMessage([], ZERO) },
      buildMessageUpdate({ type: "thinking_start", contentIndex: 0 }),
      buildMessageUpdate({ type: "thinking_delta", contentIndex: 0, delta: "The user said hi." }),
      buildMessageUpdate({ type: "thinking_end", contentIndex: 0, content: "The user said hi." }),
      buildMessageUpdate({ type: "text_start", contentIndex: 1 }),
      buildMessageUpdate({ type: "text_delta", contentIndex: 1, delta: "OK" }),
      buildMessageUpdate({ type: "text_end", contentIndex: 1, content: "OK" }),
      {
        type: "message_end",
        message: buildMessage([{ type: "thinking", thinking: "..." }, ...TEXT]),
      },
    ]);

    expect(filterByTag(events, "item.started").map((event) => event.kind)).toEqual([
      "reasoning",
      "assistant_message",
    ]);
    const reasoning = filterByTag(events, "content.delta").filter(
      (event) => event.streamKind === "reasoning_text",
    );
    expect(reasoning.map((event) => event.delta)).toEqual(["The user said hi."]);
    // The two blocks are two items. Merged into one, the model's thinking
    // would show as part of its answer.
    expect(new Set(filterByTag(events, "item.started").map((event) => event.itemId)).size).toBe(2);
  });

  it("reports the session's usage and the turn's own cost when the run settles", () => {
    const events = normalizeFromStart(ANSWERING);

    expect(filterByTag(events, "session.usage.updated")[0]?.usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 8,
      cacheReadTokens: 30,
      cacheWriteTokens: 0,
    });
    const completed = filterByTag(events, "turn.completed")[0];
    expect(completed?.state).toBe("completed");
    expect(completed?.costUsd).toBe(usage.cost.total);
    expect(completed?.usage).toMatchObject({ inputTokens: 120, outputTokens: 8 });
  });

  it("ends no turn on a run pi will retry by itself, and leaves the warning to the retry event", () => {
    const events = normalizeFromStart([
      { type: "agent_start" },
      { type: "agent_end", messages: [], willRetry: true },
    ]);

    // The turn is not over: pi is about to run again under it.
    expect(filterByTag(events, "turn.completed")).toEqual([]);
    expect(filterByTag(events, "runtime.warning")).toEqual([]);
  });
});

describe("normalizing a tool call on a pi turn", () => {
  it("reports a shell command as a command execution, streaming only what is new", () => {
    const events = normalizeFromStart([
      { type: "agent_start" },
      buildToolStart("bash", { command: "echo hello" }),
      buildToolUpdate("hel"),
      buildToolUpdate("hello\n"),
      buildToolEnd(false),
    ]);

    expect(listEventTags(events)).toEqual([
      "turn.started",
      "item.started",
      "content.delta",
      "content.delta",
      "item.completed",
    ]);
    expect(filterByTag(events, "item.started")[0]?.kind).toBe("command_execution");
    // pi's `partialResult` is the whole output so far, so the delta is only
    // the new part at the end. Sending the whole text would repeat output.
    expect(filterByTag(events, "content.delta").map((event) => event.delta)).toEqual([
      "hel",
      "lo\n",
    ]);
    expect(filterByTag(events, "content.delta")[0]?.streamKind).toBe("command_output");
    expect(filterByTag(events, "item.completed")[0]?.status).toBe("completed");
  });

  it("reports a failed tool call as a failed item", () => {
    const events = normalizeFromStart([
      { type: "agent_start" },
      buildToolStart("bash", { command: "nope" }),
      buildToolEnd(true),
    ]);

    expect(filterByTag(events, "item.completed")[0]?.status).toBe("failed");
  });

  it("reports an edit as a file change and anything else as a tool call", () => {
    const edited = normalizeFromStart([
      { type: "agent_start" },
      buildToolStart("edit", {
        path: "/tmp/work/main.ts",
        edits: [{ oldText: "a", newText: "b" }],
      }),
    ]);
    const written = normalizeFromStart([
      { type: "agent_start" },
      buildToolStart("write", { path: "/tmp/work/new.ts", content: "b" }),
    ]);
    const other = normalizeFromStart([
      { type: "agent_start" },
      buildToolStart("mcp__jira__create", { summary: "ship it" }),
    ]);

    expect(filterByTag(edited, "item.started")[0]?.kind).toBe("file_change");
    expect(filterByTag(written, "item.started")[0]?.kind).toBe("file_change");
    expect(filterByTag(other, "item.started")[0]?.kind).toBe("tool_call");
  });
});

describe("the edited path of a pi file change", () => {
  const startEdit = (toolName: string, args: Record<string, unknown>) =>
    filterByTag(
      normalizeFromStart([{ type: "agent_start" }, buildToolStart(toolName, args)]),
      "item.started",
    )[0];

  it("writes the path as pi received it, for edit and write", () => {
    expect(startEdit("edit", { path: "src/a.ts", edits: [] })?.detail).toEqual({
      path: "src/a.ts",
    });
    expect(startEdit("write", { path: "/work/b.ts", content: "" })?.detail).toEqual({
      path: "/work/b.ts",
    });
  });

  it("applies pi's rules for @, ~ and Unicode spaces", () => {
    expect(startEdit("write", { path: "@src/a.ts" })?.detail).toEqual({ path: "src/a.ts" });
    expect(startEdit("write", { path: "~/x/a.ts" })?.detail).toEqual({ path: "/home/ada/x/a.ts" });
    expect(startEdit("write", { path: "~" })?.detail).toEqual({ path: HOME });
    expect(startEdit("write", { path: "a\u00A0b.ts" })?.detail).toEqual({ path: "a b.ts" });
  });

  it("writes a long path whole and leaves out one over 512 characters", () => {
    const whole = `src/${"d/".repeat(200)}a.ts`;
    expect(startEdit("write", { path: whole })?.detail).toEqual({ path: whole });
    const tooLong = `src/${"a".repeat(600)}.ts`;
    expect(startEdit("write", { path: tooLong })?.detail).toEqual({ name: "write" });
  });

  it("writes no path when the call has none", () => {
    expect(startEdit("edit", {})?.detail).toEqual({ name: "edit" });
  });
});

describe("normalizing a file read or a file search on a pi turn", () => {
  /** Normalizes one call to `toolName` and returns the item it started. */
  const startTool = (toolName: string, args: Record<string, unknown>) =>
    filterByTag(
      normalizeFromStart([{ type: "agent_start" }, buildToolStart(toolName, args)]),
      "item.started",
    )[0];

  it("reports a read and a grep in one turn as a file read and a file search", () => {
    const events = normalizeFromStart([
      { type: "agent_start" },
      { ...buildToolStart("read", { path: "src/main.ts", offset: 10 }), toolCallId: "call_read" },
      {
        ...buildToolStart("grep", { pattern: "TODO", path: "src", ignoreCase: true }),
        toolCallId: "call_grep",
      },
    ]);

    expect(
      filterByTag(events, "item.started").map(({ kind, detail }) => ({ kind, detail })),
    ).toEqual([
      { kind: "file_read", detail: { name: "read", path: "src/main.ts" } },
      { kind: "file_search", detail: { name: "grep", pattern: "TODO", path: "src" } },
    ]);
  });

  it("reports find as a file search with its pattern and path", () => {
    expect(startTool("find", { pattern: "*.ts", path: "src" })).toMatchObject({
      kind: "file_search",
      detail: { name: "find", pattern: "*.ts", path: "src" },
    });
  });

  it("reports ls as a file search with only a path, even when it was given a pattern", () => {
    // pi accepts a pattern on `ls` and ignores it, so the listing was not filtered.
    const started = startTool("ls", { path: "src", pattern: "*.secret" });

    expect(started?.kind).toBe("file_search");
    expect(started?.detail).toEqual({ name: "ls", path: "src" });
  });

  // A field that would be empty is left out, so a surface never shows a blank
  // path or pattern as if the tool had given one.
  for (const [label, value] of [
    ["missing", undefined],
    ["not a string", 42],
    ["empty", ""],
  ] as const) {
    it(`leaves out a ${label} path and pattern`, () => {
      const args = value === undefined ? {} : { path: value, pattern: value };

      expect(startTool("read", args)?.detail).toEqual({ name: "read" });
      expect(startTool("grep", args)?.detail).toEqual({ name: "grep" });
      expect(startTool("edit", args)?.detail).toEqual({ name: "edit" });
    });
  }

  it("cuts a long path to the fact bound, and marks the cut", () => {
    const path = `src/${"a".repeat(10_000)}.ts`;

    expect(startTool("read", { path })?.detail).toEqual({
      name: "read",
      path: `${path.slice(0, MAX_FACT_LENGTH - 1)}…`,
    });
  });
});

describe("the tools the extension writes mark files for", () => {
  it("are exactly the tools reported as command executions and file changes", () => {
    // pi's built-in tools, the runner's subagent tool, and one tool that is not built in.
    const tools = ["read", "grep", "find", "ls", "bash", "powershell", "write", "edit"];
    const writing = [...tools, SUBAGENT_TOOL, "mcp__jira__create"].filter((toolName) => {
      const events = normalizeFromStart([{ type: "agent_start" }, buildToolStart(toolName, {})]);
      const kind = filterByTag(events, "item.started")[0]?.kind;
      return kind === "command_execution" || kind === "file_change";
    });

    expect([...writing].sort()).toEqual([...FILE_WRITING_TOOLS].sort());
  });
});

describe("a name that is also an object method", () => {
  it("reports a tool named constructor as a tool call", () => {
    const events = normalizeFromStart([
      { type: "agent_start" },
      buildToolStart("constructor", {}),
      { ...buildToolStart("__proto__", {}), toolCallId: "call_proto" },
    ]);

    expect(filterByTag(events, "item.started").map((event) => event.kind)).toEqual([
      "tool_call",
      "tool_call",
    ]);
  });

  it("ignores a content block of type constructor", () => {
    const events = normalizeFromStart([
      { type: "agent_start" },
      buildMessageUpdate({ type: "constructor_start", contentIndex: 0 }),
    ]);

    expect(filterByTag(events, "item.started")).toEqual([]);
  });
});

describe("normalizing a subagent call on a pi turn", () => {
  const CHILD: SubagentId = "pi-child-1";
  const TASK = { description: "Count the tests", prompt: "Count the test files in src." };

  it("reports a subagent call as a subagent item, named by its task", () => {
    const events = normalizeFromStart([
      { type: "agent_start" },
      buildToolStart(SUBAGENT_TOOL, TASK),
    ]);

    const started = filterByTag(events, "item.started")[0];
    expect(started?.kind).toBe("subagent");
    // The prompt can be long, so the row shows only the task's short name.
    expect(started?.detail).toEqual({ name: SUBAGENT_TOOL, description: "Count the tests" });
  });

  it("lists the subagent the call started on the call's completion", () => {
    const state = buildTestState();
    normalizeEvents(state, [{ type: "agent_start" }, buildToolStart(SUBAGENT_TOOL, TASK)]);
    // The adapter records the subagent on the call's item once it started it.
    state.tools.get(CALL)!.subagentId = CHILD;

    const events = normalizeEvents(state, [buildToolEnd(false)]);

    expect(filterByTag(events, "item.completed")[0]?.detail).toEqual({
      name: SUBAGENT_TOOL,
      description: "Count the tests",
      subagentIds: [CHILD],
    });
  });

  it("lists the subagent on a call the turn's end completes as failed", () => {
    const state = buildTestState();
    normalizeEvents(state, [{ type: "agent_start" }, buildToolStart(SUBAGENT_TOOL, TASK)]);
    state.tools.get(CALL)!.subagentId = CHILD;

    const events = normalizeEvents(state, [{ type: "agent_settled" }]);

    const completed = filterByTag(events, "item.completed")[0];
    expect(completed?.status).toBe("failed");
    // Without the id, the row of a call cut off by the turn's end would lose
    // its link to the subagent it started.
    expect(completed?.detail).toEqual({
      name: SUBAGENT_TOOL,
      description: "Count the tests",
      subagentIds: [CHILD],
    });
  });

  it("lists no subagent on a call that started none", () => {
    const events = normalizeFromStart([
      { type: "agent_start" },
      buildToolStart(SUBAGENT_TOOL, TASK),
      buildToolEnd(true),
    ]);

    expect(filterByTag(events, "item.completed")[0]?.detail).toEqual({
      name: SUBAGENT_TOOL,
      description: "Count the tests",
    });
  });
});

describe("the last text an agent wrote in a turn", () => {
  const TOOL_ONLY = [{ type: "toolCall", id: CALL, name: "bash", arguments: { command: "ls" } }];

  it("is the text of the last message that has any, skipping messages that only call tools", () => {
    const state = buildTestState();

    normalizeEvents(state, [
      { type: "agent_start" },
      { type: "turn_end", message: buildMessage([{ type: "text", text: "Looking." }]) },
      {
        type: "turn_end",
        message: buildMessage([
          { type: "text", text: "There are " },
          { type: "thinking", thinking: "counted" },
          { type: "text", text: "12." },
        ]),
      },
      { type: "turn_end", message: buildMessage(TOOL_ONLY) },
    ]);

    // A subagent's reply to its parent is this text, so a last message that
    // only calls tools must not blank it out.
    expect(state.lastAssistantText).toBe("There are 12.");
  });

  it("starts empty again with the next turn", () => {
    const state = buildTestState();
    normalizeEvents(state, ANSWERING);
    expect(state.lastAssistantText).toBe("OK");

    normalizeEvents(state, [{ type: "agent_start" }]);

    // A turn that writes nothing must not reply with the previous turn's text.
    expect(state.lastAssistantText).toBe("");
  });
});

describe("normalizing a subagent's pi process", () => {
  const CHILD: SubagentId = "pi-child-1";

  /** Returns the session's own state after one answered turn, and a subagent state built from it. */
  const buildRootAndChild = () => {
    const root = buildTestState();
    normalizeEvents(root, ANSWERING);
    return { root, child: buildSubagentState(root, CHILD) };
  };

  it("attributes every event to the subagent, except the session's total", () => {
    const { child } = buildRootAndChild();

    const events = normalizeEvents(child, ANSWERING);

    const unattributed = events.filter((event) => !("subagentId" in event));
    expect(listEventTags(unattributed)).toEqual(["session.usage.updated"]);
    for (const event of events) {
      if ("subagentId" in event) expect(event.subagentId).toBe(CHILD);
    }
    expect(events.length).toBeGreaterThan(unattributed.length);
  });

  it("reports its own usage and the session's total, which now includes it", () => {
    const { child } = buildRootAndChild();

    const events = normalizeEvents(child, ANSWERING);

    const [own, session] = filterByTag(events, "session.usage.updated");
    expect(own?.subagentId).toBe(CHILD);
    expect(own?.usage).toMatchObject({ inputTokens: 120, outputTokens: 8 });
    expect(session !== undefined && "subagentId" in session).toBe(false);
    // The session's own agent spent one answer, and the subagent another.
    expect(session?.usage).toMatchObject({ inputTokens: 240, outputTokens: 16 });
  });

  it("completes its turn with its own usage and cost", () => {
    const { child } = buildRootAndChild();

    const completed = filterByTag(normalizeEvents(child, ANSWERING), "turn.completed")[0];

    expect(completed?.subagentId).toBe(CHILD);
    expect(completed?.usage).toMatchObject({ inputTokens: 120, outputTokens: 8 });
    expect(completed?.costUsd).toBe(usage.cost.total);
  });

  it("leaves the subagent out of the usage on the session's own turn", () => {
    const { root, child } = buildRootAndChild();
    normalizeEvents(child, ANSWERING);

    const events = normalizeEvents(root, ANSWERING);

    // The session's own agent answered twice; the subagent's answer is not
    // its own.
    expect(filterByTag(events, "turn.completed")[0]?.usage).toMatchObject({
      inputTokens: 240,
      outputTokens: 16,
    });
    // The session's total still counts the subagent, after it ended.
    expect(filterByTag(events, "session.usage.updated")).toHaveLength(1);
    expect(filterByTag(events, "session.usage.updated")[0]?.usage).toMatchObject({
      inputTokens: 360,
      outputTokens: 24,
    });
  });
});

describe("how a turn ends when it does not simply finish", () => {
  const buildStoppedEvents = (stopReason: string, extra: Record<string, unknown> = {}) => [
    { type: "agent_start" },
    { type: "turn_end", message: { ...buildMessage(TEXT), stopReason, ...extra }, toolResults: [] },
    {
      type: "agent_end",
      messages: [{ ...buildMessage(TEXT), stopReason, ...extra }],
      willRetry: false,
    },
    { type: "agent_settled" },
  ];

  it("reports a turn the user stopped as interrupted", () => {
    const events = normalizeFromStart(buildStoppedEvents("aborted"));

    expect(filterByTag(events, "turn.completed")[0]?.state).toBe("interrupted");
  });

  it("reports a turn that ended on an error as failed, with pi's error message", () => {
    const events = normalizeFromStart(
      buildStoppedEvents("error", { errorMessage: "1210 thinking is not supported" }),
    );

    const completed = filterByTag(events, "turn.completed")[0];
    expect(completed?.state).toBe("failed");
    expect(completed?.error).toContain("1210");
    // The error is also reported when it happens: the turn state alone would
    // say that something went wrong, but not what.
    expect(filterByTag(events, "runtime.error")[0]?.class).toBe("agent_error");
  });

  it("keeps one turn across pi's own retry, and counts the cost of both attempts", () => {
    const events = normalizeFromStart([
      { type: "agent_start" },
      { type: "turn_end", message: buildMessage(TEXT), toolResults: [] },
      { type: "agent_end", messages: [], willRetry: true },
      { type: "agent_start" },
      { type: "turn_end", message: buildMessage(TEXT), toolResults: [] },
      { type: "agent_end", messages: [buildMessage(TEXT)], willRetry: false },
      { type: "agent_settled" },
    ]);

    // One turn: the attempt after a retry continues the same turn.
    expect(filterByTag(events, "turn.started")).toHaveLength(1);
    expect(filterByTag(events, "turn.completed")).toHaveLength(1);
    // The failed attempt's cost was still spent.
    expect(filterByTag(events, "turn.completed")[0]?.costUsd).toBeCloseTo(usage.cost.total * 2, 12);
  });

  it("keeps one turn across a compaction and across a queued message", () => {
    const answered = [
      { type: "turn_end", message: buildMessage(TEXT), toolResults: [] },
      { type: "agent_end", messages: [buildMessage(TEXT)], willRetry: false },
    ];
    const compacted = normalizeFromStart([
      { type: "agent_start" },
      ...answered,
      { type: "compaction_start", reason: "threshold" },
      { type: "compaction_end", reason: "overflow", result: null, aborted: false, willRetry: true },
      // pi runs again by itself once it has room, which is the same turn.
      { type: "agent_start" },
      ...answered,
      { type: "agent_settled" },
    ]);
    const queued = normalizeFromStart([
      { type: "agent_start" },
      ...answered,
      // A steer that landed between the run ending and the session settling.
      { type: "agent_start" },
      ...answered,
      { type: "agent_settled" },
    ]);

    for (const events of [compacted, queued]) {
      expect(filterByTag(events, "turn.started")).toHaveLength(1);
      expect(filterByTag(events, "turn.completed")).toHaveLength(1);
      expect(filterByTag(events, "turn.completed")[0]?.costUsd).toBeCloseTo(
        usage.cost.total * 2,
        12,
      );
    }
  });

  it("reports an error pi retried and gave up on once, not twice", () => {
    const events = normalizeFromStart([
      { type: "agent_start" },
      {
        type: "agent_end",
        messages: [{ ...buildMessage(TEXT), stopReason: "error", errorMessage: "529 overloaded" }],
        willRetry: false,
      },
      // pi reports the end of its retries after the `agent_end` of the last run.
      { type: "auto_retry_end", success: false, attempt: 3, finalError: "529 overloaded" },
    ]);

    expect(filterByTag(events, "runtime.error")).toHaveLength(1);
    expect(filterByTag(events, "runtime.error")[0]?.class).toBe("agent_error");
  });

  it("warns that an answer was cut off at the output limit, and still completes the turn", () => {
    const events = normalizeFromStart([
      { type: "agent_start" },
      {
        type: "turn_end",
        message: { ...buildMessage(TEXT), stopReason: "length" },
        toolResults: [],
      },
      { type: "agent_settled" },
    ]);

    expect(filterByTag(events, "runtime.warning")[0]?.message).toContain("cut short");
    expect(filterByTag(events, "turn.completed")[0]?.state).toBe("completed");
  });

  it("completes the items still running when the turn ends, as failed", () => {
    const events = normalizeFromStart([
      { type: "agent_start" },
      { type: "message_start", message: buildMessage([], ZERO) },
      buildMessageUpdate({ type: "text_start", contentIndex: 0 }),
      buildToolStart("bash", { command: "sleep 100" }),
      { type: "agent_settled" },
    ]);

    // A tool whose result never came and a block pi stopped mid-stream. An
    // item nobody completes would show a spinner for the rest of the session.
    expect(filterByTag(events, "item.completed").map((event) => event.status)).toEqual([
      "failed",
      "failed",
    ]);
    expect(filterByTag(events, "item.completed")).toHaveLength(
      filterByTag(events, "item.started").length,
    );
  });

  it("reports extension and retry errors without ending the turn", () => {
    const extension = normalizeFromStart([
      { type: "agent_start" },
      {
        type: "extension_error",
        extensionPath: "/tmp/hercule-extension.ts",
        event: "tool_call",
        error: "the approval hook threw",
      },
    ]);
    const retries = normalizeFromStart([
      { type: "agent_start" },
      { type: "auto_retry_end", success: false, attempt: 3, finalError: "529 overloaded" },
    ]);

    expect(filterByTag(extension, "runtime.error")[0]?.class).toBe("extension_error");
    expect(filterByTag(extension, "runtime.error")[0]?.message).toContain(
      "the approval hook threw",
    );
    expect(filterByTag(retries, "runtime.error")[0]?.class).toBe("auto_retry_failed");
    expect(filterByTag(retries, "runtime.error")[0]?.message).toContain("529");
    // Neither ends the turn; the settle that follows does.
    expect(filterByTag(extension, "turn.completed")).toEqual([]);
    expect(filterByTag(retries, "turn.completed")).toEqual([]);
  });
});

describe("a line from pi that is not a valid event", () => {
  it("warns about it and goes on with the next line", () => {
    const running = buildTestState();

    const stray = normalizeEvents(running, [{ type: "agent_start" }]).concat(
      normalize(running, "pi: warning, something on stdout that is not JSON"),
    );
    const after = normalizeEvents(running, [{ type: "agent_settled" }]);

    expect(filterByTag(stray, "runtime.warning")).toHaveLength(1);
    expect(filterByTag(stray, "runtime.warning")[0]?.message ?? "").not.toBe("");
    // The warning does not include the line, because the line could just as
    // well contain a credential in a stack trace.
    expect(filterByTag(stray, "runtime.warning")[0]?.message).not.toContain("something on stdout");
    // The line is skipped, not turned into some other event: it holds nothing
    // about the turn.
    expect(listEventTags(stray)).toEqual(["turn.started", "runtime.warning"]);
    expect(listEventTags(after)).toContain("turn.completed");
  });
});

/**
 * The tests below use the event shapes of pi 1.3 (`AgentSessionEvent` in
 * `core/agent-session.d.ts`, and the RPC frames in `modes/rpc/rpc-mode.js`).
 * Every event they produce is encoded with the protocol schema, so an event the
 * controller could not accept fails here.
 */
const encodeEvent = Schema.encodeUnknownSync(ProviderEvent);

const normalizeAndEncode = (
  running: ReturnType<typeof buildNormalizingState>,
  events: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<ProviderEvent> => {
  const produced = normalizeEvents(running, events);
  for (const event of produced) encodeEvent(event);
  return produced;
};

/** Builds a state that collects what it reports to the runner's log. */
const buildReportingState = () => {
  const reports: Array<{ readonly label: string; readonly error: unknown }> = [];
  const running = buildNormalizingState(SESSION, NATIVE, undefined, HOME, (label, error) => {
    reports.push({ label, error });
  });
  return { running, reports };
};

const COMPACTION_RESULT = {
  summary: "The user asked for a refactor. The auth module is done.",
  firstKeptEntryId: "e42",
  tokensBefore: 180_000,
  estimatedTokensAfter: 42_000,
};

const COMPACTING = [
  { type: "compaction_start", reason: "threshold" },
  {
    type: "compaction_end",
    reason: "threshold",
    result: COMPACTION_RESULT,
    aborted: false,
    willRetry: false,
  },
];

describe("a pi compaction", () => {
  it("draws one running item that completes with the token counts and the summary", () => {
    const events = normalizeAndEncode(buildTestState(), [
      { type: "agent_start" },
      ...COMPACTING,
      { type: "agent_settled" },
    ]);

    const started = filterByTag(events, "item.started");
    const completed = filterByTag(events, "item.completed");
    expect(started.map((event) => event.kind)).toEqual(["context_compaction"]);
    expect(completed.map((event) => [event.kind, event.status])).toEqual([
      ["context_compaction", "completed"],
    ]);
    expect(started[0]?.itemId).toBe(completed[0]?.itemId);
    expect(Schema.decodeUnknownSync(ContextCompactionDetail)(started[0]?.detail)).toEqual({
      trigger: "auto",
    });
    expect(Schema.decodeUnknownSync(ContextCompactionDetail)(completed[0]?.detail)).toEqual({
      trigger: "auto",
      tokensBefore: 180_000,
      tokensAfter: 42_000,
      summary: COMPACTION_RESULT.summary,
    });
    // The compaction is inside the user's turn, which it neither opens nor closes.
    expect(listEventTags(events)).toEqual([
      "turn.started",
      "item.started",
      "item.completed",
      "session.usage.updated",
      "turn.completed",
    ]);
  });

  it.each([
    ["manual", "manual"],
    ["threshold", "auto"],
    ["overflow", "auto"],
  ])("reads the trigger of a %s compaction as %s", (reason, trigger) => {
    const events = normalizeAndEncode(buildTestState(), [
      { type: "agent_start" },
      { type: "compaction_start", reason },
    ]);

    expect(filterByTag(events, "item.started")[0]?.detail).toEqual({ trigger });
  });

  it("cuts a summary to the length of a message", () => {
    const events = normalizeAndEncode(buildTestState(), [
      { type: "agent_start" },
      { type: "compaction_start", reason: "manual" },
      {
        type: "compaction_end",
        reason: "manual",
        result: { ...COMPACTION_RESULT, summary: "x".repeat(MAX_MESSAGE_LENGTH * 2) },
        aborted: false,
        willRetry: false,
      },
    ]);

    const detail = Schema.decodeUnknownSync(ContextCompactionDetail)(
      filterByTag(events, "item.completed")[0]?.detail,
    );
    expect(detail.summary?.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
  });

  it.each([
    ["was aborted", { result: undefined, aborted: true }, false],
    ["was aborted after it had a result", { result: COMPACTION_RESULT, aborted: true }, false],
    ["ended with no result", { result: undefined, aborted: false }, false],
    [
      "failed with an error",
      { result: undefined, aborted: false, errorMessage: "Auto-compaction failed: 529 overloaded" },
      true,
    ],
  ])(
    "fails the item of a compaction that %s, and never draws it as a success",
    (_name, end, warns) => {
      const events = normalizeAndEncode(buildTestState(), [
        { type: "agent_start" },
        { type: "compaction_start", reason: "threshold" },
        { type: "compaction_end", reason: "threshold", willRetry: false, ...end },
      ]);

      const completed = filterByTag(events, "item.completed");
      expect(completed.map((event) => event.status)).toEqual(["failed"]);
      expect(completed[0]?.detail).toEqual({ trigger: "auto" });
      // pi's own error message reaches the user, because the item has no field for it.
      expect(filterByTag(events, "runtime.warning").map((event) => event.message)).toEqual(
        warns ? ["Auto-compaction failed: 529 overloaded"] : [],
      );
    },
  );

  it("shows a failed item for an end that has no start, which pi sends when overflow recovery fails", () => {
    const events = normalizeAndEncode(buildTestState(), [
      { type: "agent_start" },
      {
        type: "compaction_end",
        reason: "overflow",
        result: undefined,
        aborted: false,
        willRetry: false,
        errorMessage: "Context overflow recovery failed after one compact-and-retry attempt.",
      },
    ]);

    expect(listEventTags(events)).toEqual([
      "turn.started",
      "item.started",
      "item.completed",
      "runtime.warning",
    ]);
    expect(filterByTag(events, "item.completed")[0]?.status).toBe("failed");
  });

  it("draws one item for a second compaction_start while one runs", () => {
    const events = normalizeAndEncode(buildTestState(), [
      { type: "agent_start" },
      { type: "compaction_start", reason: "threshold" },
      { type: "compaction_start", reason: "threshold" },
      COMPACTING[1]!,
    ]);

    expect(filterByTag(events, "item.started")).toHaveLength(1);
    expect(filterByTag(events, "item.completed")).toHaveLength(1);
  });

  it("belongs to the turn of an input when pi compacts before it starts the run", () => {
    // The adapter creates the turn when it sends the input, so pi's compaction
    // before `agent_start` finds a turn that is not announced yet.
    const running = buildTestState();
    running.turnId = "turn-of-the-input";

    const events = normalizeAndEncode(running, [
      ...COMPACTING,
      ...ANSWERING.slice(0, 1),
      ...ANSWERING.slice(1),
    ]);

    expect(listEventTags(events)).toEqual([
      "turn.started",
      "item.started",
      "item.completed",
      "item.started",
      "content.delta",
      "content.delta",
      "item.completed",
      "session.usage.updated",
      "turn.completed",
    ]);
    expect(filterByTag(events, "turn.started")).toHaveLength(1);
    expect(filterByTag(events, "turn.completed")).toHaveLength(1);
    for (const event of events) {
      if ("turnId" in event) expect(event.turnId).toBe("turn-of-the-input");
    }
    expect(filterByTag(events, "turn.completed")[0]?.costUsd).toBe(usage.cost.total);
  });

  it("opens a synthetic turn for a compaction between turns, and closes it when the compaction ends", () => {
    const running = buildTestState();

    const events = normalizeAndEncode(running, [
      { type: "compaction_start", reason: "manual" },
      { ...COMPACTING[1], reason: "manual" },
    ]);

    expect(listEventTags(events)).toEqual([
      "turn.started",
      "item.started",
      "item.completed",
      "session.usage.updated",
      "turn.completed",
    ]);
    expect(filterByTag(events, "turn.completed")[0]?.state).toBe("completed");
    expect(running.turnId).toBeUndefined();
  });

  it("keeps a synthetic turn open while the compaction runs", () => {
    const events = normalizeAndEncode(buildTestState(), [
      { type: "compaction_start", reason: "manual" },
    ]);

    expect(listEventTags(events)).toEqual(["turn.started", "item.started"]);
  });

  it("gives no structured result to a synthetic turn of a session with an output schema", () => {
    const running = buildNormalizingState(
      SESSION,
      NATIVE,
      { type: "object", additionalProperties: false, required: [], properties: {} },
      HOME,
      () => undefined,
    );

    const events = normalizeAndEncode(running, [
      { type: "compaction_start", reason: "manual" },
      { ...COMPACTING[1], reason: "manual" },
    ]);

    expect(filterByTag(events, "turn.completed")[0]?.structuredResult).toBeUndefined();
  });

  it("leaves the turn open when pi starts a run during a compaction, because the turn is now the user's", () => {
    const running = buildTestState();

    const events = normalizeAndEncode(running, [
      { type: "compaction_start", reason: "manual" },
      { type: "agent_start" },
      { ...COMPACTING[1], reason: "manual" },
    ]);

    expect(filterByTag(events, "turn.started")).toHaveLength(1);
    expect(filterByTag(events, "turn.completed")).toEqual([]);
    expect(running.turnId).toBeDefined();
    expect(normalizeAndEncode(running, [{ type: "agent_settled" }]).map((e) => e._tag)).toContain(
      "turn.completed",
    );
  });

  it("fails a compaction that is still running when the turn settles", () => {
    const events = normalizeAndEncode(buildTestState(), [
      { type: "agent_start" },
      { type: "compaction_start", reason: "threshold" },
      { type: "agent_settled" },
    ]);

    expect(listEventTags(events)).toEqual([
      "turn.started",
      "item.started",
      "item.completed",
      "session.usage.updated",
      "turn.completed",
    ]);
    const completed = filterByTag(events, "item.completed")[0];
    expect(completed?.status).toBe("failed");
    expect(completed?.detail).toEqual({ trigger: "auto" });
  });

  it("fails a compaction that is still running when pi exits", () => {
    const running = buildTestState();
    normalizeAndEncode(running, [{ type: "compaction_start", reason: "manual" }]);

    const events = endTurn(running, { state: "failed", error: "pi exited" });

    expect(filterByTag(events, "item.completed").map((event) => event.status)).toEqual(["failed"]);
    expect(filterByTag(events, "turn.completed")[0]?.state).toBe("failed");
    expect(running.compaction).toBeUndefined();
  });

  it("shows nothing for the automatic compactions Hercule's extension cancels, and still draws a manual one", () => {
    const cancelled = () => {
      const running = buildTestState();
      running.automaticCompactionCancelled = true;
      return running;
    };
    const aborted = (reason: string) => ({
      type: "compaction_end",
      reason,
      result: undefined,
      aborted: true,
      willRetry: false,
    });

    const automatic = normalizeAndEncode(cancelled(), [
      { type: "agent_start" },
      { type: "compaction_start", reason: "threshold" },
      aborted("threshold"),
      {
        type: "compaction_end",
        reason: "overflow",
        result: undefined,
        aborted: false,
        errorMessage: "Context overflow recovery failed",
      },
    ]);
    const manual = normalizeAndEncode(cancelled(), [
      { type: "compaction_start", reason: "manual" },
      aborted("manual"),
    ]);

    expect(listEventTags(automatic)).toEqual(["turn.started"]);
    expect(filterByTag(manual, "item.completed").map((event) => event.status)).toEqual(["failed"]);
  });

  it("attributes a subagent's compaction to the subagent", () => {
    const child = buildSubagentState(buildTestState(), "pi-child-1");
    child.turnId = "child-turn";

    const events = normalizeAndEncode(child, COMPACTING);

    const own = events.filter((event) => event._tag !== "session.usage.updated");
    expect(listEventTags(own)).toEqual(["turn.started", "item.started", "item.completed"]);
    for (const event of own) {
      expect("subagentId" in event ? event.subagentId : undefined).toBe("pi-child-1");
    }
  });
});

describe("a pi automatic retry", () => {
  const RETRY = {
    type: "auto_retry_start",
    attempt: 2,
    maxAttempts: 3,
    delayMs: 4000,
    errorMessage: "529 overloaded",
  };

  it("warns once with the attempt, the wait and pi's error", () => {
    const events = normalizeAndEncode(buildTestState(), [{ type: "agent_start" }, RETRY]);

    expect(filterByTag(events, "runtime.warning").map((event) => event.message)).toEqual([
      "pi is retrying after an error (attempt 2 of 3, in 4s): 529 overloaded",
    ]);
  });

  it("shows one warning for a retry, whichever of the two events pi sends first", () => {
    // pi sends `agent_end` with `willRetry` first, then `auto_retry_start`.
    const events = normalizeAndEncode(buildTestState(), [
      { type: "agent_start" },
      { type: "agent_end", messages: [], willRetry: true },
      RETRY,
      { type: "agent_start" },
    ]);

    expect(filterByTag(events, "runtime.warning")).toHaveLength(1);
    expect(filterByTag(events, "turn.started")).toHaveLength(1);
    expect(filterByTag(events, "turn.completed")).toEqual([]);
  });

  it("shows a retry with fields it cannot read as an unknown item", () => {
    const { running, reports } = buildReportingState();

    const events = normalizeAndEncode(running, [
      { type: "agent_start" },
      { type: "auto_retry_start", attempt: "two" },
    ]);

    expect(filterByTag(events, "runtime.warning")).toEqual([]);
    expect(filterByTag(events, "item.started").map((event) => event.kind)).toEqual(["unknown"]);
    expect(reports.map((report) => report.label)).toEqual(["pi: auto_retry_start"]);
    expect(reports[0]?.error).toBeInstanceOf(Error);
  });
});

describe("an extension's UI request in pi", () => {
  const buildRequest = (method: string, fields: Record<string, unknown>) => ({
    type: "extension_ui_request",
    id: "0199e0e7-0000-7000-8000-0000000000a1",
    method,
    ...fields,
  });

  it.each([
    ["with no level", {}, "runtime.notice"],
    ["of level info", { notifyType: "info" }, "runtime.notice"],
    ["of level warning", { notifyType: "warning" }, "runtime.warning"],
    ["of level error", { notifyType: "error" }, "runtime.warning"],
  ])("shows a notification %s as a %s", (_name, fields, tag) => {
    const events = normalizeAndEncode(buildTestState(), [
      buildRequest("notify", { message: "Skill reloaded", ...fields }),
    ]);

    expect(events.map((event) => [event._tag, "message" in event ? event.message : ""])).toEqual([
      [tag, "Skill reloaded"],
    ]);
  });

  it("puts a notification in the open turn and opens no turn between turns", () => {
    const inTurn = normalizeAndEncode(buildTestState(), [
      { type: "agent_start" },
      buildRequest("notify", { message: "hello" }),
    ]);
    const between = normalizeAndEncode(buildTestState(), [
      buildRequest("notify", { message: "hello" }),
    ]);

    expect(filterByTag(inTurn, "runtime.notice")[0]?.turnId).toBeDefined();
    expect(listEventTags(between)).toEqual(["runtime.notice"]);
    expect(filterByTag(between, "runtime.notice")[0]?.turnId).toBeUndefined();
  });

  it.each([
    buildRequest("setStatus", { statusKey: "k", statusText: "busy" }),
    buildRequest("setWidget", { widgetKey: "k", widgetLines: ["a"] }),
    buildRequest("setTitle", { title: "pi" }),
    buildRequest("set_editor_text", { text: "draft" }),
    buildRequest("select", { title: "Pick", options: ["a", "b"] }),
    buildRequest("editor", { title: "Edit", prefill: "x" }),
    buildRequest("notify", { message: "" }),
  ])("shows nothing for %j", (request) => {
    expect(normalizeAndEncode(buildTestState(), [{ type: "agent_start" }, request]).length).toBe(1);
  });

  it("shows a method this build does not know as an unknown item labelled with it", () => {
    const { running, reports } = buildReportingState();

    const events = normalizeAndEncode(running, [buildRequest("setFooter", { lines: [] })]);

    const detail = Schema.decodeUnknownSync(UnknownItemDetail)(
      filterByTag(events, "item.completed")[0]?.detail,
    );
    expect(detail.label).toBe("pi: extension_ui_request/setFooter");
    expect(reports.map((report) => report.label)).toEqual([detail.label]);
  });

  it("shows a notification whose message is not text as an unknown item", () => {
    const events = normalizeAndEncode(buildTestState(), [
      buildRequest("notify", { message: { text: "hi" } }),
    ]);

    expect(filterByTag(events, "item.started")[0]?.kind).toBe("unknown");
    expect(filterByTag(events, "runtime.notice")).toEqual([]);
  });
});

describe("an event in pi 1.3 that the runner shows nothing for", () => {
  it.each([
    { type: "turn_start" },
    { type: "message_start", message: buildMessage([], ZERO) },
    { type: "message_end", message: buildMessage(TEXT) },
    { type: "queue_update", steering: [], followUp: [] },
    { type: "entry_appended", entry: { id: "e1" } },
    { type: "session_info_changed", name: "refactor" },
    { type: "thinking_level_changed", level: "high" },
    {
      type: "summarization_retry_scheduled",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1000,
      errorMessage: "x",
    },
    { type: "summarization_retry_attempt_start", source: "compaction", reason: "threshold" },
    { type: "summarization_retry_finished" },
    { type: "bash_execution_update", id: "b1", delta: "out" },
  ])("drops $type inside a turn without an item or a warning", (event) => {
    const events = normalizeAndEncode(buildTestState(), [{ type: "agent_start" }, event]);

    expect(listEventTags(events)).toEqual(["turn.started"]);
  });
});

describe("an event in pi that the runner has no decision for", () => {
  it("shows an unknown type as a labelled item in the open turn, and tells the log reporter its label", () => {
    const { running, reports } = buildReportingState();

    const events = normalizeAndEncode(running, [
      { type: "agent_start" },
      { type: "sleep_started", seconds: 30 },
      { type: "sleep_started", seconds: 60 },
    ]);

    expect(listEventTags(events)).toEqual([
      "turn.started",
      "item.started",
      "item.completed",
      "item.started",
      "item.completed",
    ]);
    const started = filterByTag(events, "item.started");
    expect(started.map((event) => event.kind)).toEqual(["unknown", "unknown"]);
    expect(started[0]?.detail).toEqual({ label: "pi: sleep_started" });
    expect(started[0]?.raw?.payload).toEqual({ type: "sleep_started", seconds: 30 });
    expect(filterByTag(events, "item.completed")[0]?.detail).toEqual({
      label: "pi: sleep_started",
    });
    // The reporter itself writes each label to the log once.
    expect(reports.map((report) => report.label)).toEqual([
      "pi: sleep_started",
      "pi: sleep_started",
    ]);
    expect(reports[0]?.error).toBeUndefined();
  });

  it("holds an unknown type between turns in a synthetic turn that closes right after it", () => {
    const running = buildTestState();

    const events = normalizeAndEncode(running, [{ type: "sleep_started" }]);

    expect(listEventTags(events)).toEqual([
      "turn.started",
      "item.started",
      "item.completed",
      "session.usage.updated",
      "turn.completed",
    ]);
    expect(filterByTag(events, "turn.completed")[0]?.state).toBe("completed");
    expect(running.turnId).toBeUndefined();
  });

  it("keeps an unknown type that arrives during a compaction out of the compaction's synthetic turn closing", () => {
    const events = normalizeAndEncode(buildTestState(), [
      { type: "compaction_start", reason: "manual" },
      { type: "sleep_started" },
    ]);

    expect(filterByTag(events, "turn.completed")).toEqual([]);
  });

  it("gives the synthetic turn of a session with an output schema no structured result", () => {
    const running = buildNormalizingState(
      SESSION,
      NATIVE,
      { type: "object", additionalProperties: false, required: [], properties: {} },
      HOME,
      () => undefined,
    );

    const events = normalizeAndEncode(running, [{ type: "sleep_started" }]);

    expect(filterByTag(events, "turn.completed")[0]?.structuredResult).toBeUndefined();
  });

  it.each([
    ["a name of an object method", { type: "constructor" }, "pi: constructor"],
    ["no type", { id: 1 }, "pi: event with no type"],
    ["a type that is not text", { type: 7 }, "pi: event with no type"],
  ])("shows an event with %s as an unknown item", (_name, event, label) => {
    const events = normalizeAndEncode(buildTestState(), [{ type: "agent_start" }, event]);

    expect(filterByTag(events, "item.started")[0]?.detail).toEqual({ label });
  });

  it.each([
    ["null", "pi: event with no type"],
    ["5", "pi: event with no type"],
  ])("shows the JSON line %s as an unknown item", (line, label) => {
    const events = normalize(buildTestState(), line);

    expect(filterByTag(events, "item.started")[0]?.detail).toEqual({ label });
  });

  it("writes a type's control characters as escapes in the label", () => {
    const events = normalizeAndEncode(buildTestState(), [{ type: "a\nb\u202ec" }]);

    expect(filterByTag(events, "item.started")[0]?.detail).toEqual({
      label: "pi: a\\u{a}b\\u{202e}c",
    });
  });

  it("attributes a subagent's unknown event to the subagent", () => {
    const child = buildSubagentState(buildTestState(), "pi-child-1");
    child.turnId = "child-turn";

    const events = normalizeAndEncode(child, [{ type: "sleep_started" }]);

    for (const event of filterByTag(events, "item.started")) {
      expect(event.subagentId).toBe("pi-child-1");
    }
  });
});
