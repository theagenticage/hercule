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
import { describe, expect, it } from "vitest";
import { MAX_FACT_LENGTH, type ProviderEvent, type SubagentId } from "@hercule/protocol";
import { normalize, buildNormalizingState, buildSubagentState } from "./normalize";
import { SUBAGENT_TOOL } from "./extension";

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

const buildTestState = () => buildNormalizingState(SESSION, NATIVE, undefined);

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

  it("warns about a run pi will retry by itself, and ends no turn on it", () => {
    const events = normalizeFromStart([
      { type: "agent_start" },
      { type: "agent_end", messages: [], willRetry: true },
    ]);

    expect(filterByTag(events, "runtime.warning")).toHaveLength(1);
    expect(filterByTag(events, "runtime.warning")[0]?.message ?? "").not.toBe("");
    // The turn is not over: pi is about to run again under it.
    expect(filterByTag(events, "turn.completed")).toEqual([]);
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

  it("reports ls as a file search with only a path, because it has no pattern", () => {
    expect(startTool("ls", { path: "src" })).toMatchObject({
      kind: "file_search",
      detail: { name: "ls", path: "src" },
    });
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
