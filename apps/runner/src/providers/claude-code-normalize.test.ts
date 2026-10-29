/**
 * The SDK messages below were captured from the real CLI, version 2.1.263,
 * during one turn in which the model thought, ran `echo hi` with `Bash`, and
 * replied. Long signatures and unused fields were removed; nothing else was
 * changed.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ContextCompactionDetail,
  MAX_FRAME_BYTES,
  MAX_MESSAGE_LENGTH,
  ProviderEvent,
  UnknownItemDetail,
  type ContinuedSubagent,
  type OutputSchema,
} from "@hercule/protocol";
import {
  CLAUDE_SDK_MESSAGE,
  normalize,
  buildNormalizingState,
  completeCompactionAtEnd,
  isAnyAgentWorking,
  openTurn,
  type Normalizing,
} from "./claude-code-normalize";
import { measureFrameBytes } from "../frame-size";
import { deferUntilTurnOpens, type RequestOpened } from "./claude-code-subagents";
import {
  BRIEF,
  NATIVE,
  SUBAGENT_MODEL,
  buildAgentCall,
  buildSubagentText,
  buildTaskNotification,
  buildTaskStarted,
} from "./claude-code.testing";

const SESSION = "0199e0e7-0000-7000-8000-0000000000ff";
const MESSAGE = "msg_011CeoxAoRk4jaxYB956uTmL";
const TOOL = "toolu_016JZjZUP3FNEkwxFk3eJZao";

/**
 * Builds a state with readable ids, numbered in the order they are created: the
 * tenth is `id-10`. `reportUnknownMessage` is what the runner's log would
 * get; most tests do not look at it.
 */
const buildTestState = (
  outputSchema?: OutputSchema,
  seeded?: ReadonlyArray<ContinuedSubagent>,
  reportUnknownMessage: Normalizing["reportUnknownMessage"] = () => {},
  resumed = false,
) => {
  let minted = 0;
  return buildNormalizingState(
    SESSION,
    () => `id-${(minted += 1)}`,
    () => "2026-09-07T10:51:47.000Z",
    // No schema means the session replies in free text, as most turns in this
    // file do. Tests that need structured output pass a schema.
    outputSchema,
    reportUnknownMessage,
    seeded,
    resumed,
  );
};

/** Builds a state whose reports to the runner's log are collected in `reports`. */
const buildReportingState = () => {
  const reports: Array<{ readonly label: string; readonly error: unknown }> = [];
  const running = buildTestState(undefined, undefined, (label, error) => {
    reports.push({ label, error });
  });
  return { running, reports };
};

/** An output schema, like the one a session started for an Agent gets on every turn. */
const OUTPUT_SCHEMA: OutputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict"],
  properties: { verdict: { type: "string", enum: ["accept", "dismiss"] } },
};

/**
 * A provider event. `formatEvent` turns each one into a short line, so a whole
 * turn reads as a list.
 */
type Event = Schema.Schema.Type<typeof ProviderEvent>;

const formatEvent = (event: Event): string => {
  const line = formatEventBody(event);
  // A subagent's event ends with `@<its id>`, so a list shows which agent each
  // event belongs to. `subagent.started` names its subagent in its body.
  return event._tag !== "subagent.started" &&
    "subagentId" in event &&
    event.subagentId !== undefined
    ? `${line} @${event.subagentId}`
    : line;
};

const formatEventBody = (event: Event): string => {
  switch (event._tag) {
    case "subagent.started":
      return `subagent.started ${event.subagentId} parent=${event.parentSubagentId ?? "main"} item=${event.itemId ?? "-"}`;
    case "turn.started":
      return event.model === undefined ? "turn.started" : `turn.started ${event.model}`;
    case "item.started":
      return `item.started ${event.kind} ${event.itemId}`;
    case "item.completed":
      return `item.completed ${event.kind} ${event.itemId} ${event.status}`;
    case "content.delta":
      return `content.delta ${event.streamKind} ${JSON.stringify(event.delta)}`;
    case "turn.completed":
      return `turn.completed ${event.state}`;
    case "session.exited":
      return `session.exited ${event.reason}`;
    default:
      return event._tag;
  }
};

const normalizeMessages = (
  messages: ReadonlyArray<unknown>,
  running = buildTestState(),
): ReadonlyArray<string> =>
  messages.flatMap((message) => normalize(running, message as SDKMessage).map(formatEvent));

const INIT = {
  type: "system",
  subtype: "init",
  session_id: NATIVE,
  model: "claude-haiku-4-5",
  cwd: "/tmp/work",
  permissionMode: "bypassPermissions",
};

const MESSAGE_START = {
  type: "stream_event",
  session_id: NATIVE,
  parent_tool_use_id: null,
  event: {
    type: "message_start",
    message: { id: MESSAGE, model: "claude-haiku-4-5-20251001", role: "assistant" },
  },
};

const MESSAGE_AFTER_TOOL = "msg_011CeoxAw86VZLxeZK3hZpRd";

/** The model call after a tool result is a new call, so it starts a new message. */
const MESSAGE_START_AFTER_TOOL = {
  type: "stream_event",
  session_id: NATIVE,
  parent_tool_use_id: null,
  event: {
    type: "message_start",
    message: { id: MESSAGE_AFTER_TOOL, model: "claude-haiku-4-5-20251001", role: "assistant" },
  },
};

const buildStreamEvent = (event: unknown) => ({
  type: "stream_event",
  session_id: NATIVE,
  parent_tool_use_id: null,
  event,
});

const THINKING_START = buildStreamEvent({
  type: "content_block_start",
  index: 0,
  content_block: { type: "thinking", thinking: "", signature: "" },
});

const THINKING_DELTA = buildStreamEvent({
  type: "content_block_delta",
  index: 0,
  delta: { type: "thinking_delta", thinking: "The user wants an echo." },
});

const SIGNATURE_DELTA = buildStreamEvent({
  type: "content_block_delta",
  index: 0,
  delta: { type: "signature_delta", signature: "EoMDCrIBCBEYAipAdq0YOrgkNZI" },
});

const THINKING_STOP = buildStreamEvent({ type: "content_block_stop", index: 0 });

const TOOL_START = buildStreamEvent({
  type: "content_block_start",
  index: 1,
  content_block: {
    type: "tool_use",
    id: TOOL,
    name: "Bash",
    input: {},
    caller: { type: "direct" },
  },
});

const TOOL_ARGUMENT_DELTA = buildStreamEvent({
  type: "content_block_delta",
  index: 1,
  delta: { type: "input_json_delta", partial_json: '{"command": "echo hi' },
});

const TEXT_START = buildStreamEvent({
  type: "content_block_start",
  index: 1,
  content_block: { type: "text", text: "" },
});

const TEXT_DELTA = buildStreamEvent({
  type: "content_block_delta",
  index: 1,
  delta: { type: "text_delta", text: "ready" },
});

const TEXT_STOP = buildStreamEvent({ type: "content_block_stop", index: 1 });

const ASSISTANT_TOOL_USE = {
  type: "assistant",
  uuid: "4c6485ca-097a-43f5-8709-6865c49705ca",
  session_id: NATIVE,
  parent_tool_use_id: null,
  message: {
    id: MESSAGE,
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: TOOL,
        name: "Bash",
        input: { command: "echo hi", description: "Echo hi" },
        caller: { type: "direct" },
      },
    ],
  },
};

const ASSISTANT_THINKING = {
  type: "assistant",
  uuid: "0595186b-87ba-4537-8db6-3480488892a0",
  session_id: NATIVE,
  parent_tool_use_id: null,
  message: {
    id: MESSAGE,
    role: "assistant",
    content: [{ type: "thinking", thinking: "The user wants an echo.", signature: "EoMDCrI" }],
  },
};

const ASSISTANT_TEXT = {
  type: "assistant",
  uuid: "9a53f5b7-6af4-4ae7-a838-cc4dfd531a8b",
  session_id: NATIVE,
  parent_tool_use_id: null,
  message: { id: MESSAGE, role: "assistant", content: [{ type: "text", text: "ready" }] },
};

const TOOL_RESULT = {
  type: "user",
  session_id: NATIVE,
  parent_tool_use_id: null,
  uuid: "b7aa7458-44c1-4aed-8e9e-bc1f301e8246",
  message: {
    role: "user",
    content: [{ tool_use_id: TOOL, type: "tool_result", content: "hi", is_error: false }],
  },
  tool_use_result: { stdout: "hi", stderr: "", interrupted: false },
};

const RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 2,
  result: "ready",
  total_cost_usd: 0.0325823,
  usage: {
    input_tokens: 18,
    cache_creation_input_tokens: 14688,
    cache_read_input_tokens: 14523,
    output_tokens: 151,
  },
  // Two entries: the extra call that generated the session title, and the main
  // loop. `usage` above counts only the main loop, and only this turn.
  modelUsage: {
    "claude-haiku-4-5-20251001": {
      inputTokens: 911,
      outputTokens: 14,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0.000981,
      contextWindow: 200000,
      maxOutputTokens: 32000,
    },
    "claude-haiku-4-5": {
      inputTokens: 18,
      outputTokens: 151,
      cacheReadInputTokens: 14523,
      cacheCreationInputTokens: 14688,
      webSearchRequests: 0,
      costUSD: 0.0316013,
      contextWindow: 200000,
      maxOutputTokens: 32000,
    },
  },
  terminal_reason: "completed",
  stop_reason: "end_turn",
  session_id: NATIVE,
  uuid: "8b6f4e21-0000-4000-8000-000000000001",
};

const RATE_LIMIT = {
  type: "rate_limit_event",
  session_id: NATIVE,
  rate_limit_info: { status: "allowed_warning", rateLimitType: "seven_day", utilization: 0.65 },
};

const STATUS = { type: "system", subtype: "status", status: "requesting", session_id: NATIVE };

/** Builds a `system` message of the given subtype. */
const buildSystem = (subtype: string, fields: Readonly<Record<string, unknown>> = {}) => ({
  type: "system",
  subtype,
  session_id: NATIVE,
  ...fields,
});

/**
 * The seven messages Claude Code sent for `/compact`, in order, as measured
 * on the real CLI. The summary is the plain-string synthetic user
 * message, and the result counts no model turn.
 */
const SUMMARY = "This session is being continued from a previous conversation. Summary: ...";
const COMPACTING = buildSystem("status", { status: "compacting" });
const COMPACT_BOUNDARY = buildSystem("compact_boundary", {
  compact_metadata: { trigger: "manual", pre_tokens: 21326, post_tokens: 6086 },
});
const COMPACT_SUMMARY = {
  type: "user",
  session_id: NATIVE,
  isSynthetic: true,
  isReplay: false,
  parent_tool_use_id: null,
  message: { role: "user", content: SUMMARY },
};
const COMPACT_SEQUENCE = [
  COMPACTING,
  buildSystem("status", { status: null, compact_result: "success" }),
  INIT,
  COMPACT_BOUNDARY,
  COMPACT_SUMMARY,
  {
    type: "user",
    session_id: NATIVE,
    isReplay: true,
    parent_tool_use_id: null,
    message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" },
  },
  { ...RESULT, num_turns: 0, local_command: "compact" },
];

describe("normalizing SDK messages one at a time", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly messages: ReadonlyArray<unknown>;
    readonly events: ReadonlyArray<string>;
  }> = [
    {
      // The adapter creates the native id and emits `session.started` itself,
      // so `init` produces no events.
      name: "produces no events for the init message",
      messages: [INIT],
      events: [],
    },
    {
      name: "streams a text block as one assistant_message item",
      messages: [MESSAGE_START, TEXT_START, TEXT_DELTA, TEXT_STOP],
      events: [
        "turn.started",
        `item.started assistant_message ${MESSAGE}#1`,
        'content.delta assistant_text "ready"',
        `item.completed assistant_message ${MESSAGE}#1 completed`,
      ],
    },
    {
      name: "streams a thinking block as reasoning, and does not emit its signature as text",
      messages: [MESSAGE_START, THINKING_START, THINKING_DELTA, SIGNATURE_DELTA, THINKING_STOP],
      events: [
        "turn.started",
        `item.started reasoning ${MESSAGE}#0`,
        'content.delta reasoning_text "The user wants an echo."',
        `item.completed reasoning ${MESSAGE}#0 completed`,
      ],
    },
    {
      // No event kind streams tool arguments. The whole call arrives on the
      // assistant message that follows (spec 06 section 6.3).
      name: "does not stream a tool block's partial arguments",
      messages: [MESSAGE_START, TOOL_START, TOOL_ARGUMENT_DELTA],
      events: [],
    },
    {
      name: "turns a Bash call into a command_execution item with the native tool id",
      messages: [ASSISTANT_TOOL_USE],
      events: ["turn.started", `item.started command_execution ${TOOL}`],
    },
    {
      name: "completes the tool call's item with the same kind when the tool result arrives",
      messages: [ASSISTANT_TOOL_USE, TOOL_RESULT],
      events: [
        "turn.started",
        `item.started command_execution ${TOOL}`,
        `item.completed command_execution ${TOOL} completed`,
      ],
    },
    {
      name: "turns a complete assistant message that never streamed into an item",
      messages: [ASSISTANT_THINKING],
      events: [
        "turn.started",
        "item.started reasoning id-3",
        'content.delta reasoning_text "The user wants an echo."',
        "item.completed reasoning id-3 completed",
      ],
    },
    {
      // When an attached image cannot be processed, the harness writes this
      // message itself instead of failing the turn. It is the only sign the
      // user gets that the model never saw the image, so it must be shown.
      name: "shows the message the harness writes itself when an image could not be processed",
      messages: [
        {
          ...ASSISTANT_TEXT,
          message: {
            id: MESSAGE,
            role: "assistant",
            model: "<synthetic>",
            content: [
              {
                type: "text",
                text: "API Error: an image in the conversation could not be processed",
              },
            ],
          },
        },
      ],
      events: [
        "turn.started",
        "item.started assistant_message id-3",
        'content.delta assistant_text "API Error: an image in the conversation could not be processed"',
        "item.completed assistant_message id-3 completed",
      ],
    },
    {
      // The harness can leave a thinking block's text out and send only its
      // signature, which would make a blank transcript entry.
      name: "emits no item for an empty block of a message that never streamed",
      messages: [
        {
          ...ASSISTANT_THINKING,
          message: {
            ...ASSISTANT_THINKING.message,
            content: [
              { type: "thinking", thinking: "", signature: "EoMDCrI" },
              { type: "text", text: "" },
            ],
          },
        },
      ],
      events: [],
    },
    {
      // The CLI sends one complete assistant message per finished block, so a
      // block's index in its message is not its index in the stream. The
      // repeated message is recognised by its message id, not by position.
      name: "does not repeat a streamed block when the complete message arrives",
      messages: [MESSAGE_START, THINKING_START, THINKING_DELTA, THINKING_STOP, ASSISTANT_THINKING],
      events: [
        "turn.started",
        `item.started reasoning ${MESSAGE}#0`,
        'content.delta reasoning_text "The user wants an echo."',
        `item.completed reasoning ${MESSAGE}#0 completed`,
      ],
    },
    {
      // The block that streamed at index 1 is the only block in its complete
      // message, so a check that matched by index would emit it twice.
      name: "does not repeat a text block that streamed second either",
      messages: [
        MESSAGE_START,
        TOOL_START,
        TEXT_START,
        TEXT_DELTA,
        TEXT_STOP,
        ASSISTANT_TOOL_USE,
        ASSISTANT_TEXT,
      ],
      events: [
        "turn.started",
        `item.started assistant_message ${MESSAGE}#1`,
        'content.delta assistant_text "ready"',
        `item.completed assistant_message ${MESSAGE}#1 completed`,
        `item.started command_execution ${TOOL}`,
      ],
    },
    {
      name: "closes the turn on the result and reports the usage so far",
      messages: [RESULT],
      events: ["turn.started", "session.usage.updated", "turn.completed completed"],
    },
    {
      // A rate limit that still allows work and a plain status update hold
      // nothing a reader needs, so both are dropped on purpose (spec 06
      // section 6.7).
      name: "drops informational messages instead of turning them into items",
      messages: [RATE_LIMIT, STATUS],
      events: [],
    },
    {
      // A system message can arrive after the `result` that closed the last
      // turn, so the turn opened for it must be closed after it too.
      name: "turns an unrecognised message into an unknown item in its own turn",
      messages: [{ type: "system", subtype: "image_generated", session_id: NATIVE }],
      events: [
        "turn.started",
        "item.started unknown id-3",
        "item.completed unknown id-3 completed",
        "turn.completed completed",
      ],
    },
    {
      name: "reports a retry as a runtime warning, not an item",
      messages: [
        {
          type: "system",
          subtype: "api_retry",
          attempt: 1,
          max_retries: 3,
          retry_delay_ms: 1000,
          error_status: 529,
          error: "overloaded",
          session_id: NATIVE,
        },
      ],
      events: ["runtime.warning"],
    },
    {
      // The item completes at the message after the boundary, which may hold
      // the summary, so the turn it opened stays open until then.
      name: "starts a context_compaction item at a boundary no status announced",
      messages: [COMPACT_BOUNDARY],
      events: ["turn.started", "item.started context_compaction id-3"],
    },
  ];

  for (const one of cases) {
    it(one.name, () => {
      expect(normalizeMessages(one.messages)).toEqual(one.events);
    });
  }
});

const TURN = [
  INIT,
  STATUS,
  MESSAGE_START,
  THINKING_START,
  THINKING_DELTA,
  SIGNATURE_DELTA,
  THINKING_STOP,
  TOOL_START,
  TOOL_ARGUMENT_DELTA,
  ASSISTANT_THINKING,
  ASSISTANT_TOOL_USE,
  TOOL_RESULT,
  RATE_LIMIT,
  MESSAGE_START_AFTER_TOOL,
  TEXT_START,
  TEXT_DELTA,
  TEXT_STOP,
  RESULT,
];

describe("normalizing a whole turn", () => {
  it("produces the events of the turn in order", () => {
    expect(normalizeMessages(TURN)).toEqual([
      "turn.started",
      `item.started reasoning ${MESSAGE}#0`,
      'content.delta reasoning_text "The user wants an echo."',
      `item.completed reasoning ${MESSAGE}#0 completed`,
      `item.started command_execution ${TOOL}`,
      `item.completed command_execution ${TOOL} completed`,
      `item.started assistant_message ${MESSAGE_AFTER_TOOL}#1`,
      'content.delta assistant_text "ready"',
      `item.completed assistant_message ${MESSAGE_AFTER_TOOL}#1 completed`,
      "session.usage.updated",
      "turn.completed completed",
    ]);
  });

  it("attaches the vendor payload to the first event of each message, and never to a delta", () => {
    const running = buildTestState();
    const raw = TURN.flatMap((message) => normalize(running, message as SDKMessage)).filter(
      (event) => event.raw !== undefined,
    );
    expect(raw.length).toBeGreaterThan(0);
    for (const event of raw) {
      expect(event.raw?.source).toBe(CLAUDE_SDK_MESSAGE);
      expect(event._tag).not.toBe("content.delta");
    }
  });

  it("reports the usage from the result", () => {
    const running = buildTestState();
    const events = normalize(running, RESULT as unknown as SDKMessage);
    const snapshot = events.find((event) => event._tag === "session.usage.updated");
    // The sum over every model call the session made, not only this turn's main loop.
    expect(snapshot?._tag === "session.usage.updated" ? snapshot.usage : undefined).toEqual({
      inputTokens: 929,
      outputTokens: 165,
      cacheReadTokens: 14523,
      cacheWriteTokens: 14688,
      costUsd: 0.0325823,
    });
  });

  it("opens the next turn after the result closed the last one", () => {
    const running = buildTestState();
    normalize(running, RESULT as unknown as SDKMessage);
    expect(running.turnId).toBeUndefined();
    const next = normalize(running, ASSISTANT_TOOL_USE as unknown as SDKMessage);
    expect(next[0]?._tag).toBe("turn.started");
  });
});

describe("a turn that does not complete normally", () => {
  it("reports an abort as interrupted", () => {
    const events = normalizeMessages([{ ...RESULT, terminal_reason: "aborted_streaming" }]);
    expect(events).toContain("turn.completed interrupted");
  });

  it("reports an error result as failed, with the harness's error message", () => {
    const running = buildTestState();
    const events = normalize(running, {
      ...RESULT,
      subtype: "error_during_execution",
      is_error: true,
      errors: ["the model refused"],
      terminal_reason: "model_error",
    } as unknown as SDKMessage);
    const done = events.find((event) => event._tag === "turn.completed");
    expect(done?._tag === "turn.completed" ? done.error : undefined).toBe("the model refused");
  });
});

describe("item details", () => {
  const readItemDetail = (
    messages: ReadonlyArray<unknown>,
    itemId: string,
    tag: "item.started" | "item.completed",
  ): unknown => {
    const running = buildTestState();
    const events = messages.flatMap((message) => normalize(running, message as SDKMessage));
    for (const event of events) {
      if (event._tag === tag && event.itemId === itemId) return event.detail;
    }
    return undefined;
  };

  it("includes the tool name and the arguments it was called with", () => {
    expect(readItemDetail([ASSISTANT_TOOL_USE], TOOL, "item.started")).toEqual({
      name: "Bash",
      input: { command: "echo hi", description: "Echo hi" },
    });
  });

  it("marks a tool as MCP or native based on its name", () => {
    const buildToolUse = (name: string) => ({
      ...ASSISTANT_TOOL_USE,
      message: {
        ...ASSISTANT_TOOL_USE.message,
        content: [{ type: "tool_use", id: TOOL, name, input: {} }],
      },
    });
    expect(readItemDetail([buildToolUse("mcp__linear__issues")], TOOL, "item.started")).toEqual({
      name: "mcp__linear__issues",
      input: {},
      kind: "mcp",
    });
    expect(readItemDetail([buildToolUse("Frobnicate")], TOOL, "item.started")).toEqual({
      name: "Frobnicate",
      input: {},
      kind: "native",
    });
  });

  /** Builds one assistant message that calls each tool in turn, ids `toolu_0`, `toolu_1`, ... */
  const buildToolCalls = (calls: ReadonlyArray<readonly [name: string, input: unknown]>) => ({
    ...ASSISTANT_TOOL_USE,
    message: {
      ...ASSISTANT_TOOL_USE.message,
      content: calls.map(([name, input], index) => ({
        type: "tool_use",
        id: `toolu_${index}`,
        name,
        input,
      })),
    },
  });

  const listStartedItems = (messages: ReadonlyArray<unknown>) =>
    messages
      .flatMap((message) => normalize(buildTestState(), message as SDKMessage))
      .flatMap((event) =>
        event._tag === "item.started" ? [{ kind: event.kind, detail: event.detail }] : [],
      );

  it("makes a file_read item for each Read and a file_search item for a Grep, with the path or pattern beside the input", () => {
    const calls = [
      ["Read", { file_path: "/work/a.ts" }],
      ["Read", { file_path: "/tmp/shot.png", limit: 20 }],
      ["Grep", { pattern: "TODO", path: "/work/src", output_mode: "content" }],
    ] as const;
    expect(listStartedItems([buildToolCalls(calls)])).toEqual([
      {
        kind: "file_read",
        detail: { name: "Read", input: calls[0][1], path: "/work/a.ts" },
      },
      {
        kind: "file_read",
        detail: { name: "Read", input: calls[1][1], path: "/tmp/shot.png" },
      },
      {
        kind: "file_search",
        detail: { name: "Grep", input: calls[2][1], pattern: "TODO", path: "/work/src" },
      },
    ]);
  });

  it("writes the edited path whole on a file_change item, for Edit, MultiEdit, Write and NotebookEdit", () => {
    const longPath = `/work/${"d/".repeat(190)}file.ts`;
    const calls = [
      ["Edit", { file_path: "/work/a.ts", old_string: "a", new_string: "b" }],
      ["MultiEdit", { file_path: "/work/b.ts", edits: [] }],
      ["Write", { file_path: longPath, content: "x" }],
      ["NotebookEdit", { notebook_path: "/work/n.ipynb" }],
    ] as const;
    const items = listStartedItems([buildToolCalls(calls)]);
    expect(items.map((item) => item.kind)).toEqual([
      "file_change",
      "file_change",
      "file_change",
      "file_change",
    ]);
    expect(items.map((item) => (item.detail as { path?: string }).path)).toEqual([
      "/work/a.ts",
      "/work/b.ts",
      longPath,
      "/work/n.ipynb",
    ]);
    expect(longPath.length).toBeGreaterThan(300);
  });

  it("leaves the path out of a file_change item when it is over 512 characters or missing", () => {
    const calls = [
      ["Write", { file_path: `/${"a".repeat(512)}`, content: "x" }],
      ["Edit", {}],
    ] as const;
    for (const item of listStartedItems([buildToolCalls(calls)])) {
      expect(item.detail).not.toHaveProperty("path");
      expect(item.detail).not.toHaveProperty("paths");
    }
  });

  /** Builds the `tool_result` for one of the ids `buildToolCalls` made. */
  const buildResultOf = (toolUseId: string, parentToolUseId: string | null = null) => ({
    ...TOOL_RESULT,
    parent_tool_use_id: parentToolUseId,
    message: {
      role: "user",
      content: [{ tool_use_id: toolUseId, type: "tool_result", content: "ok", is_error: false }],
    },
  });

  /** Returns the `detail` of every `item.completed` the messages produce. */
  const listCompletedDetails = (
    running: ReturnType<typeof buildTestState>,
    messages: ReadonlyArray<unknown>,
  ) =>
    messages
      .flatMap((message) => normalize(running, message as SDKMessage))
      .flatMap((event) => (event._tag === "item.completed" ? [event.detail] : []));

  it("puts the edited path on the item.completed of a file_change tool", () => {
    const calls = [
      ["Edit", { file_path: "/work/a.ts" }],
      ["Write", { file_path: "/work/b.ts", content: "x" }],
    ] as const;
    expect(
      listCompletedDetails(buildTestState(), [
        buildToolCalls(calls),
        buildResultOf("toolu_1"),
        buildResultOf("toolu_0"),
      ]),
    ).toMatchObject([{ path: "/work/b.ts" }, { path: "/work/a.ts" }]);
  });

  it("puts no path on the item.completed of a tool that is not a file_change", () => {
    const running = buildTestState();
    const details = listCompletedDetails(running, [
      buildToolCalls([["Read", { file_path: "/work/a.ts" }]]),
      buildResultOf("toolu_0"),
    ]);
    expect(details[0]).not.toHaveProperty("path");
  });

  it("forgets the path of a tool whose turn was interrupted, so a late result reports no edit", () => {
    const running = buildTestState();
    const details = listCompletedDetails(running, [
      buildToolCalls([["Edit", { file_path: "/work/a.ts" }]]),
      { ...RESULT, terminal_reason: "aborted_streaming" },
      buildResultOf("toolu_0"),
    ]);
    expect(details).toHaveLength(1);
    expect(details[0]).not.toHaveProperty("path");
  });

  it("forgets the path of a subagent's tool when the session's own turn is interrupted", () => {
    const running = buildTestState();
    const subagentCall = buildToolCalls([["Edit", { file_path: "/work/sub.ts" }]]);
    const details = listCompletedDetails(running, [
      { ...subagentCall, parent_tool_use_id: "toolu_agent" },
      { ...RESULT, terminal_reason: "aborted_streaming" },
      buildResultOf("toolu_0", "toolu_agent"),
    ]);
    expect(details.every((detail) => !("path" in (detail as object)))).toBe(true);
  });

  it("leaves out the path or pattern a file tool was not given", () => {
    const calls = [
      ["LS", { path: "/work" }],
      ["Glob", { pattern: "**/*.ts" }],
      ["Grep", { pattern: "TODO", path: "" }],
      ["Read", {}],
    ] as const;
    expect(listStartedItems([buildToolCalls(calls)])).toEqual([
      { kind: "file_search", detail: { name: "LS", input: calls[0][1], path: "/work" } },
      { kind: "file_search", detail: { name: "Glob", input: calls[1][1], pattern: "**/*.ts" } },
      { kind: "file_search", detail: { name: "Grep", input: calls[2][1], pattern: "TODO" } },
      { kind: "file_read", detail: { name: "Read", input: {} } },
    ]);
  });

  it("includes the tool's output on the item the tool result completes", () => {
    expect(readItemDetail([ASSISTANT_TOOL_USE, TOOL_RESULT], TOOL, "item.completed")).toEqual({
      content: "hi",
    });
  });

  /**
   * Whether an input was steered into a running turn is known only from the
   * adapter's own `SendResult`, and the harness's repeated message does not
   * show which input it repeats. So the adapter reports user messages, and the
   * normalizer reports none (spec 06 section 6.3).
   */
  it("makes no user_message item when the harness repeats the input it was sent", () => {
    const buildUserEcho = (content: unknown) => ({
      type: "user",
      session_id: NATIVE,
      parent_tool_use_id: null,
      message: { role: "user", content },
    });

    for (const content of ["run the tests", [{ type: "text", text: "run the tests" }]]) {
      const running = buildTestState();
      const events = normalize(running, buildUserEcho(content) as unknown as SDKMessage);
      // No events at all: no item, and not even the turn the message opened.
      expect(events).toEqual([]);
    }
  });

  it("attaches the vendor payload to the unknown item, not to the turn it opened", () => {
    const running = buildTestState();
    const events = normalize(running, {
      type: "system",
      subtype: "image_generated",
      session_id: NATIVE,
    } as unknown as SDKMessage);
    expect(events.find((event) => event.raw !== undefined)?._tag).toBe("item.started");
  });
});

describe("runtime warnings", () => {
  it("reports the retry attempt and the error that caused it", () => {
    const running = buildTestState();
    const events = normalize(running, {
      type: "system",
      subtype: "api_retry",
      attempt: 1,
      max_retries: 3,
      retry_delay_ms: 1000,
      error_status: 529,
      error: "overloaded",
      session_id: NATIVE,
    } as unknown as SDKMessage);
    const warned = events.find((event) => event._tag === "runtime.warning");
    expect(warned?._tag === "runtime.warning" ? warned.message : undefined).toBe(
      "retrying after overloaded: attempt 1 of 3",
    );
  });
});

describe("an interrupted turn", () => {
  it("has no error, because the text it stopped on is the assistant's reply, not a reason", () => {
    const running = buildTestState();
    const events = normalize(running, {
      ...RESULT,
      result: "Here is the partial answer I had",
      terminal_reason: "aborted_streaming",
    } as unknown as SDKMessage);
    const done = events.find((event) => event._tag === "turn.completed");
    expect(done?._tag === "turn.completed" ? done.state : undefined).toBe("interrupted");
    expect(done?._tag === "turn.completed" ? done.error : undefined).toBeUndefined();
  });
});

describe("encoding the events with the protocol schema", () => {
  const encode = Schema.encodeUnknownSync(ProviderEvent);

  it("encodes every event a whole turn produces", () => {
    const running = buildTestState();
    for (const message of TURN) {
      for (const event of normalize(running, message as SDKMessage)) {
        expect(() => encode(event)).not.toThrow();
      }
    }
  });

  it("encodes a turn whose output matches its schema, and one whose output does not", () => {
    for (const structured_output of [{ verdict: "accept" }, { verdict: "maybe" }]) {
      const running = buildTestState(OUTPUT_SCHEMA);
      const events = normalize(running, { ...RESULT, structured_output } as unknown as SDKMessage);
      const done = events.find((event) => event._tag === "turn.completed");
      expect(done?._tag === "turn.completed" ? done.structuredResult?.outcome : undefined).toBe(
        structured_output.verdict === "accept" ? "ok" : "schema-failure",
      );
      for (const event of events) expect(() => encode(event)).not.toThrow();
    }
  });

  it("encodes a tool result that came back with no output at all", () => {
    const running = buildTestState();
    const events = [
      ASSISTANT_TOOL_USE,
      {
        ...TOOL_RESULT,
        message: { role: "user", content: [{ tool_use_id: TOOL, type: "tool_result" }] },
      },
    ].flatMap((message) => normalize(running, message as SDKMessage));
    const done = events.find((event) => event._tag === "item.completed");
    expect(done?._tag === "item.completed" ? done.detail : undefined).toEqual({});
    for (const event of events) expect(() => encode(event)).not.toThrow();
  });
});

describe("malformed messages", () => {
  const broken: ReadonlyArray<readonly [string, unknown]> = [
    ["a result with no model usage", { ...RESULT, modelUsage: undefined }],
    ["a compaction with no metadata", { type: "system", subtype: "compact_boundary" }],
    ["an assistant message with no content", { type: "assistant", message: { id: MESSAGE } }],
    [
      "an error result with no errors",
      { ...RESULT, subtype: "error_during_execution", is_error: true },
    ],
  ];

  for (const [name, message] of broken) {
    it(`turns ${name} into an unknown item rather than throwing`, () => {
      const running = buildTestState();
      expect(() => normalize(running, message as SDKMessage)).not.toThrow();
      const kinds = normalizeMessages([message]).map((event) =>
        event.split(" ").slice(0, 2).join(" "),
      );
      expect(kinds).toContain("item.started unknown");
    });
  }
});

/**
 * Lists the notices and warnings in `events` as their kind and text, and where
 * the event sits: in a turn, or between turns.
 */
const listNotes = (events: ReadonlyArray<Event>): ReadonlyArray<string> =>
  events.flatMap((event) =>
    event._tag === "runtime.notice" || event._tag === "runtime.warning"
      ? [
          `${event._tag} ${JSON.stringify(event.message)} ${event.turnId === undefined ? "between turns" : "in a turn"}`,
        ]
      : [],
  );

/** Returns a state whose session has a turn open, as when the user has just sent input. */
const buildStateInTurn = () => {
  const running = buildTestState();
  openTurn(running);
  return running;
};

describe("notices and warnings", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly message: unknown;
    readonly kind: "runtime.notice" | "runtime.warning";
    readonly text: string;
  }> = [
    {
      name: "an informational message, whatever its level",
      message: buildSystem("informational", { content: "Stop hook ran", level: "warning" }),
      kind: "runtime.notice",
      text: "Stop hook ran",
    },
    {
      name: "a model refusal that fell back to another model",
      message: buildSystem("model_refusal_fallback", { content: "Retrying with another model" }),
      kind: "runtime.notice",
      text: "Retrying with another model",
    },
    {
      name: "a notification",
      message: buildSystem("notification", { key: "k", text: "Update available", priority: "low" }),
      kind: "runtime.notice",
      text: "Update available",
    },
    {
      name: "one recalled memory",
      message: buildSystem("memory_recall", { mode: "select", memories: [{ path: "/m/a.md" }] }),
      kind: "runtime.notice",
      text: "Recalled 1 memory",
    },
    {
      name: "several recalled memories",
      message: buildSystem("memory_recall", {
        mode: "select",
        memories: [{ path: "/m/a.md" }, { path: "/m/b.md" }, { path: "/m/c.md" }],
      }),
      kind: "runtime.notice",
      text: "Recalled 3 memories",
    },
    {
      name: "a cleared conversation",
      message: { type: "conversation_reset", new_conversation_id: "c-2", session_id: NATIVE },
      kind: "runtime.notice",
      text: "Conversation was cleared",
    },
    {
      name: "a model refusal with no fallback",
      message: buildSystem("model_refusal_no_fallback", { content: "The model refused" }),
      kind: "runtime.warning",
      text: "The model refused",
    },
  ];

  for (const one of cases) {
    it(`shows ${one.name} inside a turn, on that turn`, () => {
      const running = buildStateInTurn();
      const events = normalize(running, one.message as SDKMessage);
      expect(listNotes(events)).toEqual([`${one.kind} ${JSON.stringify(one.text)} in a turn`]);
      expect(events).toHaveLength(1);
    });

    it(`shows ${one.name} between turns, without opening a turn`, () => {
      const running = buildTestState();
      const events = normalize(running, one.message as SDKMessage);
      expect(listNotes(events)).toEqual([`${one.kind} ${JSON.stringify(one.text)} between turns`]);
      expect(events).toHaveLength(1);
      expect(running.turnId).toBeUndefined();
    });
  }

  const unreadable: ReadonlyArray<readonly [string, unknown, string]> = [
    [
      "an informational message whose content is a list",
      buildSystem("informational", { content: ["Stop hook ran"], level: "info" }),
      "claude: system/informational",
    ],
    [
      "a model refusal fallback whose content is an object",
      buildSystem("model_refusal_fallback", { content: { text: "x" } }),
      "claude: system/model_refusal_fallback",
    ],
    [
      "a model refusal with no fallback whose content is missing",
      buildSystem("model_refusal_no_fallback", {}),
      "claude: system/model_refusal_no_fallback",
    ],
    [
      "a notification whose text is a list",
      buildSystem("notification", { key: "k", text: ["Update available"] }),
      "claude: system/notification",
    ],
    [
      "a local command output whose content is a list",
      buildSystem("local_command_output", { content: ["Total cost"] }),
      "claude: system/local_command_output",
    ],
    [
      "a memory recall whose memories are a string",
      buildSystem("memory_recall", { mode: "select", memories: "x".repeat(57) }),
      "claude: system/memory_recall",
    ],
  ];

  for (const [name, message, label] of unreadable) {
    it(`shows ${name} as the labelled unknown item, and no notice`, () => {
      const { running, reports } = buildReportingState();
      const events = normalize(running, message as SDKMessage);
      expect(listNotes(events)).toEqual([]);
      expect(events.map(formatEvent).map((line) => line.replace(/ id-\d+/, ""))).toEqual([
        "turn.started",
        "item.started unknown",
        "item.completed unknown completed",
        "turn.completed completed",
      ]);
      expect(reports.map((report) => report.label)).toEqual([label]);
      expect(reports[0]?.error).toBeInstanceOf(Error);
    });
  }

  it("marks a notice cut to the length of a message", () => {
    const events = normalize(
      buildTestState(),
      buildSystem("notification", {
        key: "k",
        text: `${"n".repeat(MAX_MESSAGE_LENGTH - 2)}😀tail`,
      }) as unknown as SDKMessage,
    );
    const [notice] = events;
    expect(notice?._tag === "runtime.notice" ? notice.message : undefined).toBe(
      `${"n".repeat(MAX_MESSAGE_LENGTH - 2)}…`,
    );
  });

  it("shows no notice for a recall of no memories", () => {
    expect(
      normalizeMessages([buildSystem("memory_recall", { mode: "select", memories: [] })]),
    ).toEqual([]);
  });
});

describe("a usage limit", () => {
  const RESET_AT = Date.UTC(2026, 9, 28, 14, 0) / 1000;
  const buildRateLimit = (info: Readonly<Record<string, unknown>>) => ({
    type: "rate_limit_event",
    session_id: NATIVE,
    rate_limit_info: info,
  });

  it("warns when it is rejected, with the time it resets in UTC", () => {
    const running = buildStateInTurn();
    const events = normalize(
      running,
      buildRateLimit({ status: "rejected", resetsAt: RESET_AT }) as unknown as SDKMessage,
    );
    expect(listNotes(events)).toEqual([
      'runtime.warning "Usage limit reached, resets at 2026-10-28 14:00 UTC" in a turn',
    ]);
  });

  it("warns without a reset time when the message gives none", () => {
    expect(
      listNotes(
        normalize(
          buildTestState(),
          buildRateLimit({ status: "rejected" }) as unknown as SDKMessage,
        ),
      ),
    ).toEqual(['runtime.warning "Usage limit reached" between turns']);
  });

  it("warns when the overage that could cover it is rejected too", () => {
    const events = normalize(
      buildTestState(),
      buildRateLimit({
        status: "rejected",
        resetsAt: RESET_AT,
        overageStatus: "rejected",
        isUsingOverage: false,
      }) as unknown as SDKMessage,
    );
    expect(listNotes(events)).toHaveLength(1);
  });

  it("warns once while the limit stays blocked, and again when it becomes blocked after being allowed", () => {
    const running = buildTestState();
    const blocked = buildRateLimit({ status: "rejected", resetsAt: RESET_AT });
    const events = [
      blocked,
      blocked,
      buildRateLimit({ status: "rejected", resetsAt: RESET_AT + 60 }),
      buildRateLimit({ status: "allowed" }),
      blocked,
    ].map((message) => listNotes(normalize(running, message as unknown as SDKMessage)));
    expect(events.map((notes) => notes.length)).toEqual([1, 0, 0, 0, 1]);
  });

  const notBlocked: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
    ["allowed", { status: "allowed" }],
    ["close to the limit", { status: "allowed_warning", utilization: 0.9 }],
    ["rejected but overage is allowed", { status: "rejected", overageStatus: "allowed" }],
    [
      "rejected but overage is allowed with a warning",
      { status: "rejected", overageStatus: "allowed_warning" },
    ],
    ["rejected but overage is in use", { status: "rejected", isUsingOverage: true }],
    [
      "rejected but overage is in use, by its other name",
      { status: "rejected", overageInUse: true },
    ],
  ];

  for (const [name, info] of notBlocked) {
    it(`shows nothing when the limit is ${name}`, () => {
      expect(normalizeMessages([buildRateLimit(info)])).toEqual([]);
    });
  }
});

describe("output of a slash command Claude ran itself", () => {
  const OUTPUT = buildSystem("local_command_output", { content: "Total cost: $0.01" });

  it("is an assistant message in the open turn", () => {
    const running = buildStateInTurn();
    const events = normalize(running, OUTPUT as unknown as SDKMessage);
    expect(events.map(formatEvent)).toEqual([
      "item.started assistant_message id-3",
      'content.delta assistant_text "Total cost: $0.01"',
      "item.completed assistant_message id-3 completed",
    ]);
  });

  it("is an assistant message in a synthetic turn that closes after it, between turns", () => {
    expect(normalizeMessages([OUTPUT])).toEqual([
      "turn.started",
      "item.started assistant_message id-3",
      'content.delta assistant_text "Total cost: $0.01"',
      "item.completed assistant_message id-3 completed",
      "turn.completed completed",
    ]);
  });
});

describe("a message nobody decided how to show", () => {
  /** Returns the label of each `unknown` item that started in `events`. */
  const listUnknownLabels = (events: ReadonlyArray<Event>): ReadonlyArray<string | undefined> =>
    events.flatMap((event) =>
      event._tag === "item.started" && event.kind === "unknown"
        ? [Schema.decodeUnknownSync(UnknownItemDetail)(event.detail).label]
        : [],
    );

  const HOLOGRAM = { type: "hologram", session_id: NATIVE };

  const cases: ReadonlyArray<readonly [string, unknown, string]> = [
    ["a type the SDK does not list", HOLOGRAM, "claude: hologram"],
    ["a system subtype the SDK does not list", buildSystem("foo_bar"), "claude: system/foo_bar"],
    ["a system message with no subtype", { type: "system", session_id: NATIVE }, "claude: system"],
    ["a message with no type", { session_id: NATIVE }, "claude: message with no type"],
    [
      "a type named like an object method",
      { type: "constructor", session_id: NATIVE },
      "claude: constructor",
    ],
  ];

  for (const [name, message, label] of cases) {
    it(`shows ${name} as an item with the label ${label}, and reports it`, () => {
      const { running, reports } = buildReportingState();
      const first = normalize(running, message as SDKMessage);
      expect(listUnknownLabels(first)).toEqual([label]);
      expect(reports).toEqual([{ label, error: undefined }]);
      // Every message is reported. Logging a label once is up to the reporter.
      expect(listUnknownLabels(normalize(running, message as SDKMessage))).toEqual([label]);
      expect(reports).toHaveLength(2);
    });
  }

  it("closes the synthetic turn it opened right after the item", () => {
    const running = buildTestState();
    const lines = normalize(running, HOLOGRAM as unknown as SDKMessage).map(formatEvent);
    expect(lines).toEqual([
      "turn.started",
      "item.started unknown id-3",
      "item.completed unknown id-3 completed",
      "turn.completed completed",
    ]);
    expect(running.turnId).toBeUndefined();
  });

  it("labels a known message whose fields cannot be read, and reports what failed", () => {
    const { running, reports } = buildReportingState();
    const events = normalize(running, {
      type: "system",
      subtype: "compact_boundary",
    } as SDKMessage);
    expect(listUnknownLabels(events)).toEqual(["claude: system/compact_boundary"]);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.label).toBe("claude: system/compact_boundary");
    expect(reports[0]?.error).toBeInstanceOf(Error);
  });

  it("writes control and direction characters of the type and subtype as escapes", () => {
    const events = normalize(buildTestState(), {
      type: "system",
      subtype: "foo\nbar\u202ebaz",
    } as unknown as SDKMessage);
    expect(listUnknownLabels(events)).toEqual(["claude: system/foo\\u{a}bar\\u{202e}baz"]);
  });

  it("closes the synthetic turn a malformed model output message opened", () => {
    for (const message of [
      { type: "assistant", parent_tool_use_id: null },
      { type: "stream_event", parent_tool_use_id: null },
      { type: "result", subtype: "success" },
    ]) {
      const running = buildTestState();
      const lines = normalize(running, message as unknown as SDKMessage)
        .map(formatEvent)
        .map((line) => line.replace(/ id-\d+/, ""));
      expect(lines.slice(-3), message.type).toEqual([
        "item.started unknown",
        "item.completed unknown completed",
        "turn.completed completed",
      ]);
      expect(running.turnId, message.type).toBeUndefined();
    }
  });

  it("keeps the raw payload on the unknown item of a stream_event that could not be read", () => {
    const events = normalize(buildStateInTurn(), {
      type: "stream_event",
      parent_tool_use_id: null,
    } as unknown as SDKMessage);
    const unknown = events.find((event) => event._tag === "item.started");
    expect(unknown?.raw?.source).toBe(CLAUDE_SDK_MESSAGE);
  });

  it("leaves the turn that was already open when a malformed model output message arrives", () => {
    const running = buildStateInTurn();
    const lines = normalize(running, {
      type: "assistant",
      parent_tool_use_id: null,
    } as unknown as SDKMessage).map(formatEvent);
    expect(lines).toEqual(["item.started unknown id-3", "item.completed unknown id-3 completed"]);
    expect(running.turnId).toBeDefined();
  });

  it("cuts a very long type to fit the label", () => {
    const events = normalize(buildTestState(), { type: "x".repeat(2000) } as unknown as SDKMessage);
    const [label] = listUnknownLabels(events);
    expect(label?.length).toBeLessThanOrEqual(512);
    expect(label?.startsWith("claude: xxx")).toBe(true);
  });

  it("does not report a message that was dropped on purpose", () => {
    const { running, reports } = buildReportingState();
    normalize(running, buildSystem("permission_denied", { tool_name: "Bash" }) as SDKMessage);
    normalize(running, { type: "tool_progress", session_id: NATIVE } as SDKMessage);
    expect(reports).toEqual([]);
  });
});

describe("a context compaction", () => {
  /** Returns the detail of each `item.completed` event of a compaction. */
  const listCompactionDetails = (events: ReadonlyArray<Event>) =>
    events.flatMap((event) =>
      event._tag === "item.completed" && event.kind === "context_compaction"
        ? [
            event.detail === undefined
              ? undefined
              : Schema.decodeUnknownSync(ContextCompactionDetail)(event.detail),
          ]
        : [],
    );

  const COMPLETED_DETAIL = {
    trigger: "manual",
    tokensBefore: 21326,
    tokensAfter: 6086,
    summary: SUMMARY,
  };

  it("runs as one item from the compacting status to the summary, inside a turn the user started", () => {
    const running = buildStateInTurn();
    const events = COMPACT_SEQUENCE.flatMap((message) => normalize(running, message as SDKMessage));
    expect(events.map(formatEvent)).toEqual([
      "item.started context_compaction id-3",
      "item.completed context_compaction id-3 completed",
      // The result ends the user's turn, as for any other message.
      "session.usage.updated",
      "turn.completed completed",
    ]);
    const started = events.find((event) => event._tag === "item.started");
    expect(started?._tag === "item.started" ? started.detail : undefined).toEqual({});
    expect(listCompactionDetails(events)).toEqual([COMPLETED_DETAIL]);
  });

  it("runs in a synthetic turn that closes with it, and the trailing result adds no turn", () => {
    const running = buildTestState();
    const events = COMPACT_SEQUENCE.flatMap((message) => normalize(running, message as SDKMessage));
    expect(events.map(formatEvent)).toEqual([
      "turn.started",
      "item.started context_compaction id-3",
      "item.completed context_compaction id-3 completed",
      "turn.completed completed",
      "session.usage.updated",
    ]);
    expect(listCompactionDetails(events)).toEqual([COMPLETED_DETAIL]);
    expect(isAnyAgentWorking(running)).toBe(false);
  });

  it("keeps the synthetic turn open while the compaction runs", () => {
    const running = buildTestState();
    normalize(running, COMPACTING as SDKMessage);
    normalize(running, COMPACT_SEQUENCE[1] as SDKMessage);
    normalize(running, COMPACT_BOUNDARY as SDKMessage);
    expect(isAnyAgentWorking(running)).toBe(true);
  });

  it("shows one item when the compacting status arrives twice", () => {
    const lines = normalizeMessages([COMPACTING, COMPACTING], buildStateInTurn());
    expect(lines).toEqual(["item.started context_compaction id-3"]);
  });

  it("fails when the status reports the compaction failed, and closes the turn it opened", () => {
    const failed = buildSystem("status", {
      status: null,
      compact_result: "failed",
      compact_error: "too large",
    });
    expect(normalizeMessages([COMPACTING, failed])).toEqual([
      "turn.started",
      "item.started context_compaction id-3",
      "item.completed context_compaction id-3 failed",
      "turn.completed completed",
    ]);
    // In the user's turn, the turn stays open for its own result.
    expect(normalizeMessages([COMPACTING, failed], buildStateInTurn())).toEqual([
      "item.started context_compaction id-3",
      "item.completed context_compaction id-3 failed",
    ]);
  });

  it("starts the item at the boundary when no status announced it, with what the boundary knows", () => {
    const running = buildStateInTurn();
    const events = [COMPACT_BOUNDARY, COMPACT_SUMMARY].flatMap((message) =>
      normalize(running, message as SDKMessage),
    );
    const started = events.find((event) => event._tag === "item.started");
    expect(started?._tag === "item.started" ? started.detail : undefined).toEqual({
      trigger: "manual",
      tokensBefore: 21326,
      tokensAfter: 6086,
    });
    expect(listCompactionDetails(events)).toEqual([COMPLETED_DETAIL]);
  });

  it("completes without a summary at any conversation message that is not the summary", () => {
    const notSummaries: ReadonlyArray<readonly [string, unknown]> = [
      ["an assistant message", ASSISTANT_TEXT],
      ["the user's own input", { ...COMPACT_SUMMARY, isSynthetic: false }],
      ["a tool result", TOOL_RESULT],
    ];
    for (const [name, message] of notSummaries) {
      const running = buildStateInTurn();
      const events = [COMPACTING, COMPACT_BOUNDARY, message].flatMap((frame) =>
        normalize(running, frame as SDKMessage),
      );
      expect(listCompactionDetails(events), name).toEqual([
        { trigger: "manual", tokensBefore: 21326, tokensAfter: 6086 },
      ]);
    }
  });

  it("completes before the message that follows it, which keeps the turn it opened", () => {
    const running = buildTestState();
    const lines = [COMPACTING, COMPACT_BOUNDARY, ASSISTANT_TOOL_USE].flatMap((message) =>
      normalize(running, message as SDKMessage).map(formatEvent),
    );
    expect(lines.slice(0, 5)).toEqual([
      "turn.started",
      "item.started context_compaction id-3",
      "item.completed context_compaction id-3 completed",
      "turn.completed completed",
      "turn.started",
    ]);
  });

  it("cuts a summary to the length of a message", () => {
    const long = {
      ...COMPACT_SUMMARY,
      message: { role: "user", content: "s".repeat(MAX_MESSAGE_LENGTH + 100) },
    };
    const running = buildStateInTurn();
    const events = [COMPACTING, COMPACT_BOUNDARY, long].flatMap((message) =>
      normalize(running, message as SDKMessage),
    );
    const summary = listCompactionDetails(events)[0]?.summary;
    expect(summary).toHaveLength(MAX_MESSAGE_LENGTH);
    // A cut summary says so, and a cut inside an emoji drops the whole emoji.
    expect(summary?.endsWith("…")).toBe(true);
  });

  it("drops a whole emoji from a summary cut inside it", () => {
    const text = `${"s".repeat(MAX_MESSAGE_LENGTH - 2)}😀tail`;
    const running = buildStateInTurn();
    const events = [
      COMPACTING,
      COMPACT_BOUNDARY,
      { ...COMPACT_SUMMARY, message: { content: text } },
    ].flatMap((message) => normalize(running, message as SDKMessage));
    expect(listCompactionDetails(events)[0]?.summary).toBe(
      `${"s".repeat(MAX_MESSAGE_LENGTH - 2)}…`,
    );
  });

  it("fails when the turn ends before the boundary arrives", () => {
    const lines = normalizeMessages([COMPACTING, RESULT], buildStateInTurn());
    expect(lines).toEqual([
      "item.started context_compaction id-3",
      "item.completed context_compaction id-3 failed",
      "session.usage.updated",
      "turn.completed completed",
    ]);
  });

  it("fails when the session exits before the boundary arrives, and completes when it exits after", () => {
    const completeAtEnd = (running: Normalizing): ReadonlyArray<Event> => {
      const events: Array<Event> = [];
      completeCompactionAtEnd(running, events);
      return events;
    };

    const early = buildStateInTurn();
    normalize(early, COMPACTING as SDKMessage);
    expect(completeAtEnd(early).map(formatEvent)).toEqual([
      "item.completed context_compaction id-3 failed",
    ]);
    expect(completeAtEnd(early)).toEqual([]);

    const late = buildStateInTurn();
    normalize(late, COMPACTING as SDKMessage);
    normalize(late, COMPACT_BOUNDARY as SDKMessage);
    expect(listCompactionDetails(completeAtEnd(late))).toEqual([
      { trigger: "manual", tokensBefore: 21326, tokensAfter: 6086 },
    ]);
  });

  it("drops a count it cannot read and keeps the rest", () => {
    const running = buildStateInTurn();
    const boundary = buildSystem("compact_boundary", {
      compact_metadata: { trigger: "sometimes", pre_tokens: 100, post_tokens: "many" },
    });
    const events = [boundary, COMPACT_SUMMARY].flatMap((message) =>
      normalize(running, message as SDKMessage),
    );
    expect(listCompactionDetails(events)).toEqual([{ tokensBefore: 100, summary: SUMMARY }]);
  });

  it("ends as an interrupted turn when the user aborts while it compacts", () => {
    const aborted = { ...RESULT, terminal_reason: "aborted_streaming" };
    expect(normalizeMessages([COMPACTING, aborted], buildStateInTurn())).toEqual([
      "item.started context_compaction id-3",
      "item.completed context_compaction id-3 failed",
      "session.usage.updated",
      "turn.completed interrupted",
    ]);
    // Past the boundary the item has its counts, and the abort still ends the turn.
    const afterBoundary = buildStateInTurn();
    const events = [COMPACTING, COMPACT_BOUNDARY, aborted].flatMap((message) =>
      normalize(afterBoundary, message as SDKMessage),
    );
    expect(events.map(formatEvent).slice(-3)).toEqual([
      "item.completed context_compaction id-3 completed",
      "session.usage.updated",
      "turn.completed interrupted",
    ]);
    expect(listCompactionDetails(events)).toEqual([
      { trigger: "manual", tokensBefore: 21326, tokensAfter: 6086 },
    ]);
  });

  it("ends the user's turn with its own result after a failed compaction", () => {
    const failed = buildSystem("status", { status: null, compact_result: "failed" });
    expect(normalizeMessages([COMPACTING, failed, RESULT], buildStateInTurn())).toEqual([
      "item.started context_compaction id-3",
      "item.completed context_compaction id-3 failed",
      "session.usage.updated",
      "turn.completed completed",
    ]);
  });

  it("runs two compactions in a row, each in a synthetic turn that closes with it", () => {
    const running = buildTestState();
    const events = [...COMPACT_SEQUENCE, ...COMPACT_SEQUENCE].flatMap((message) =>
      normalize(running, message as SDKMessage),
    );
    expect(listCompactionDetails(events)).toEqual([COMPLETED_DETAIL, COMPLETED_DETAIL]);
    expect(events.filter((event) => event._tag === "turn.started")).toHaveLength(2);
    expect(events.filter((event) => event._tag === "turn.completed")).toHaveLength(2);
    expect(isAnyAgentWorking(running)).toBe(false);
  });

  it("fails when the status ends with no result before a boundary, and closes the turn it opened", () => {
    const ended = buildSystem("status", { status: null });
    expect(normalizeMessages([COMPACTING, ended])).toEqual([
      "turn.started",
      "item.started context_compaction id-3",
      "item.completed context_compaction id-3 failed",
      "turn.completed completed",
    ]);
    expect(normalizeMessages([COMPACTING, ended], buildStateInTurn())).toEqual([
      "item.started context_compaction id-3",
      "item.completed context_compaction id-3 failed",
    ]);
  });

  it("does not fail on a status that ends with a result, or on one after the boundary", () => {
    const succeeded = buildSystem("status", { status: null, compact_result: "success" });
    const running = buildStateInTurn();
    const events = [COMPACTING, succeeded, COMPACT_BOUNDARY].flatMap((message) =>
      normalize(running, message as SDKMessage),
    );
    expect(events.map(formatEvent)).toEqual(["item.started context_compaction id-3"]);
    // Past the boundary a status passes by: it neither fails nor completes the item.
    const ended = normalize(running, buildSystem("status", { status: null }) as SDKMessage);
    expect(ended).toEqual([]);
    expect(running.compaction).toBeDefined();
  });

  it("keeps running through a null status that carries a permission mode", () => {
    const modeUpdate = buildSystem("status", { status: null, permissionMode: "bypassPermissions" });
    const running = buildStateInTurn();
    const events = [COMPACTING, modeUpdate, COMPACT_BOUNDARY, COMPACT_SUMMARY].flatMap((message) =>
      normalize(running, message as SDKMessage),
    );
    expect(events.map(formatEvent)).toEqual([
      "item.started context_compaction id-3",
      "item.completed context_compaction id-3 completed",
    ]);
    expect(listCompactionDetails(events)).toEqual([COMPLETED_DETAIL]);
  });

  it("is not completed by a system message, a rate limit event or a tool progress tick", () => {
    const passingBy = [
      buildSystem("informational", { content: "hi", level: "info" }),
      buildSystem("status", { status: "requesting" }),
      INIT,
      RATE_LIMIT,
      { type: "tool_progress", session_id: NATIVE },
    ];
    const running = buildStateInTurn();
    const events = [COMPACTING, COMPACT_BOUNDARY, ...passingBy].flatMap((message) =>
      normalize(running, message as SDKMessage),
    );
    expect(listCompactionDetails(events)).toEqual([]);
    expect(listCompactionDetails(normalize(running, COMPACT_SUMMARY as SDKMessage))).toEqual([
      COMPLETED_DETAIL,
    ]);
  });

  describe("when a frame fails after the compaction completed with it", () => {
    const failing: ReadonlyArray<readonly [string, unknown]> = [
      [
        "an assistant message with no message",
        { type: "assistant", session_id: NATIVE, parent_tool_use_id: null, message: null },
      ],
      [
        "a user message with no message",
        { type: "user", session_id: NATIVE, parent_tool_use_id: null, message: null },
      ],
    ];

    for (const [name, frame] of failing) {
      it(`still completes the compaction and its turn before ${name}`, () => {
        const lines = normalizeMessages([COMPACTING, COMPACT_BOUNDARY, frame]).map((line) =>
          line.replace(/ id-\d+/, ""),
        );
        expect(lines).toEqual([
          "turn.started",
          "item.started context_compaction",
          "item.completed context_compaction completed",
          "turn.completed completed",
          "turn.started",
          "item.started unknown",
          "item.completed unknown completed",
          "turn.completed completed",
        ]);
      });
    }

    it("puts the raw payload on the unknown item, not on the compaction it completed", () => {
      const running = buildTestState();
      const broken = {
        type: "assistant",
        session_id: NATIVE,
        parent_tool_use_id: null,
        message: null,
      };
      for (const message of [COMPACTING, COMPACT_BOUNDARY]) {
        normalize(running, message as SDKMessage);
      }
      const events = normalize(running, broken as unknown as SDKMessage);
      const withRaw = events.filter((event) => "raw" in event && event.raw !== undefined);
      expect(withRaw.map(formatEvent).map((line) => line.replace(/ id-\d+/, ""))).toEqual([
        "item.started unknown",
      ]);
    });
  });

  describe("with a subagent working", () => {
    const registered = () => {
      const running = buildTestState();
      for (const message of [
        buildAgentCall(null, AGENT_CALL),
        buildTaskStarted(SUBAGENT, AGENT_CALL),
      ]) {
        normalize(running, message as unknown as SDKMessage);
      }
      return running;
    };

    it("is not completed by a task_notification of the subagent or a notice, and the notice shows", () => {
      const running = registered();
      const between = [
        COMPACTING,
        COMPACT_BOUNDARY,
        buildTaskNotification(SUBAGENT, AGENT_CALL),
        buildSystem("informational", { content: "Stop hook ran", level: "info" }),
      ].flatMap((message) => normalize(running, message as unknown as SDKMessage));
      expect(listCompactionDetails(between)).toEqual([]);
      expect(listNotes(between)).toEqual(['runtime.notice "Stop hook ran" in a turn']);

      const events = normalize(running, COMPACT_SUMMARY as unknown as SDKMessage);
      expect(listCompactionDetails(events)).toEqual([COMPLETED_DETAIL]);
    });

    it("is not completed by a frame of the subagent between the boundary and the summary", () => {
      const running = registered();
      const frames = [
        COMPACTING,
        COMPACT_BOUNDARY,
        buildSubagentText(AGENT_CALL, "msg_sub_1", "found it"),
        {
          ...buildStreamEvent({ type: "message_start", message: { id: "msg_sub_2" } }),
          parent_tool_use_id: AGENT_CALL,
        },
      ].flatMap((message) => normalize(running, message as unknown as SDKMessage));
      expect(listCompactionDetails(frames)).toEqual([]);

      const events = normalize(running, COMPACT_SUMMARY as unknown as SDKMessage);
      expect(listCompactionDetails(events)).toEqual([COMPLETED_DETAIL]);
    });
  });

  it("encodes every event of the sequence with the protocol schema", () => {
    const encode = Schema.encodeUnknownSync(ProviderEvent);
    const running = buildStateInTurn();
    for (const message of COMPACT_SEQUENCE) {
      for (const event of normalize(running, message as SDKMessage)) {
        expect(() => encode(event)).not.toThrow();
      }
    }
  });
});

/**
 * The ids of the subagents in the tests below. The frames they send come from
 * `claude-code.testing.ts`.
 */
const AGENT_CALL = "toolu_01626ABmfrmqSuY6p7z4RbdB";
const SUBAGENT = "acc5f22912463b884";
const NESTED_CALL = "toolu_01NestedAgentCallB00000";
const NESTED = "a77e1f0c9b2d43e58";
const SUBAGENT_TOOL = "toolu_01SubagentBashCall000000";

/** The brief a subagent was given, which Claude Code also sends as a `user` frame. */
const buildSubagentPrompt = (agentCallId: string) => ({
  type: "user",
  session_id: NATIVE,
  parent_tool_use_id: agentCallId,
  message: { role: "user", content: [{ type: "text", text: BRIEF }] },
});

const buildSubagentToolUse = (agentCallId: string, name = "Bash", input: unknown = {}) => ({
  type: "assistant",
  uuid: `uuid-${SUBAGENT_TOOL}`,
  session_id: NATIVE,
  parent_tool_use_id: agentCallId,
  message: {
    id: `msg-${SUBAGENT_TOOL}`,
    role: "assistant",
    model: SUBAGENT_MODEL,
    content: [{ type: "tool_use", id: SUBAGENT_TOOL, name, input }],
  },
});

const buildSubagentToolResult = (agentCallId: string) => ({
  type: "user",
  session_id: NATIVE,
  parent_tool_use_id: agentCallId,
  message: {
    role: "user",
    content: [{ tool_use_id: SUBAGENT_TOOL, type: "tool_result", content: "ok", is_error: false }],
  },
});

/** A request the adapter built for a subagent's approval, as `deferUntilTurnOpens` receives it. */
const buildRequestOpened = (requestId: string, subagentId: string): RequestOpened => ({
  _tag: "request.opened",
  eventId: `event-${requestId}`,
  sessionId: SESSION,
  at: "2026-09-07T10:51:47.000Z",
  subagentId,
  request: {
    requestId,
    itemId: SUBAGENT_TOOL,
    kind: "tool_approval",
    decisions: ["allow", "deny", "cancel"],
    detail: { toolName: "Write" },
  },
});

describe("a subagent's turns", () => {
  it("opens the subagent's turn at its first assistant message, with its brief as the user message", () => {
    expect(
      normalizeMessages([
        buildAgentCall(null, AGENT_CALL),
        buildTaskStarted(SUBAGENT, AGENT_CALL),
        // The brief again, as a frame: it shows once, from `task_started`.
        buildSubagentPrompt(AGENT_CALL),
        buildSubagentText(AGENT_CALL, "msg_sub_1", "found it"),
      ]),
    ).toEqual([
      "turn.started",
      `item.started subagent ${AGENT_CALL}`,
      `subagent.started ${SUBAGENT} parent=main item=${AGENT_CALL}`,
      `turn.started ${SUBAGENT_MODEL} @${SUBAGENT}`,
      `item.started user_message id-7 @${SUBAGENT}`,
      `item.completed user_message id-7 completed @${SUBAGENT}`,
      `item.started assistant_message id-10 @${SUBAGENT}`,
      `content.delta assistant_text "found it" @${SUBAGENT}`,
      `item.completed assistant_message id-10 completed @${SUBAGENT}`,
    ]);
  });

  it("introduces the subagent with the description and agent type from task_started", () => {
    const running = buildTestState();
    const [introduced] = normalize(
      running,
      buildTaskStarted(SUBAGENT, AGENT_CALL) as unknown as SDKMessage,
    );
    expect(introduced).toMatchObject({
      _tag: "subagent.started",
      subagentId: SUBAGENT,
      itemId: AGENT_CALL,
      description: "Find the config",
      agentType: "general-purpose",
    });
  });

  it("carries the brief on the user message item, as the adapter's own user messages do", () => {
    const running = buildTestState();
    const events = [
      buildTaskStarted(SUBAGENT, AGENT_CALL),
      buildSubagentText(AGENT_CALL, "msg_sub_1", "found it"),
    ].flatMap((message) => normalize(running, message as unknown as SDKMessage));
    const brief = events.find(
      (event) => event._tag === "item.started" && event.kind === "user_message",
    );
    expect(brief?._tag === "item.started" ? brief.detail : undefined).toEqual({ text: BRIEF });
  });

  it("never opens a turn of the session's own agent for a subagent's frames", () => {
    const running = buildTestState();
    const events = [
      buildTaskStarted(SUBAGENT, AGENT_CALL),
      buildSubagentPrompt(AGENT_CALL),
      buildSubagentToolUse(AGENT_CALL),
      buildSubagentToolResult(AGENT_CALL),
      buildSubagentText(AGENT_CALL, "msg_sub_1", "done"),
    ].flatMap((message) => normalize(running, message as unknown as SDKMessage));
    expect(running.turnId).toBeUndefined();
    for (const event of events) {
      if (event._tag === "subagent.started") continue;
      expect("subagentId" in event ? event.subagentId : undefined).toBe(SUBAGENT);
    }
  });

  it("does nothing for a later task_started while the subagent's turn is pending or open", () => {
    expect(
      normalizeMessages([
        buildTaskStarted(SUBAGENT, AGENT_CALL),
        buildTaskStarted(SUBAGENT, AGENT_CALL),
        buildSubagentText(AGENT_CALL, "msg_sub_1", "found it"),
        buildTaskStarted(SUBAGENT, AGENT_CALL),
      ]),
    ).toEqual([
      `subagent.started ${SUBAGENT} parent=main item=${AGENT_CALL}`,
      `turn.started ${SUBAGENT_MODEL} @${SUBAGENT}`,
      `item.started user_message id-4 @${SUBAGENT}`,
      `item.completed user_message id-4 completed @${SUBAGENT}`,
      `item.started assistant_message id-7 @${SUBAGENT}`,
      `content.delta assistant_text "found it" @${SUBAGENT}`,
      `item.completed assistant_message id-7 completed @${SUBAGENT}`,
    ]);
  });

  it("keeps the lifecycle of tasks that are not subagents trimmed", () => {
    expect(
      normalizeMessages([
        buildTaskStarted("bresy0kl9", "toolu_01ShellCall", "local_bash"),
        { type: "system", subtype: "task_progress", task_id: SUBAGENT, description: "Reading" },
        {
          type: "system",
          subtype: "task_updated",
          task_id: SUBAGENT,
          patch: { status: "running" },
        },
        buildTaskNotification("bresy0kl9", AGENT_CALL),
      ]),
    ).toEqual([]);
  });

  it("names the subagent whose frame made the Agent call as the parent of a nested subagent", () => {
    const lines = normalizeMessages([
      buildAgentCall(null, AGENT_CALL),
      buildTaskStarted(SUBAGENT, AGENT_CALL),
      buildAgentCall(AGENT_CALL, NESTED_CALL),
      buildTaskStarted(NESTED, NESTED_CALL),
    ]);
    expect(lines).toContain(`item.started subagent ${NESTED_CALL} @${SUBAGENT}`);
    expect(lines.at(-1)).toBe(`subagent.started ${NESTED} parent=${SUBAGENT} item=${NESTED_CALL}`);
  });

  for (const [status, state] of [
    ["completed", "completed"],
    ["failed", "failed"],
    ["stopped", "interrupted"],
  ] as const) {
    it(`closes the subagent's turn as ${state} when its task_notification says ${status}`, () => {
      const running = buildTestState();
      const events = [
        buildTaskStarted(SUBAGENT, AGENT_CALL),
        buildSubagentText(AGENT_CALL, "msg_sub_1", "found it"),
        buildTaskNotification(SUBAGENT, AGENT_CALL, status),
      ].flatMap((message) => normalize(running, message as unknown as SDKMessage));
      const done = events.at(-1);
      expect(done === undefined ? undefined : formatEvent(done)).toBe(
        `turn.completed ${state} @${SUBAGENT}`,
      );
      // Claude's per-task usage is not what the subagent spent (spec 06 section 13.5).
      expect(done).not.toHaveProperty("usage");
      expect(done).not.toHaveProperty("costUsd");
      expect(done).not.toHaveProperty("structuredResult");
      expect(isAnyAgentWorking(running)).toBe(false);
    });
  }

  it("opens and closes the turn of a subagent that ended before sending a frame", () => {
    expect(
      normalizeMessages([
        buildTaskStarted(SUBAGENT, AGENT_CALL),
        buildTaskNotification(SUBAGENT, AGENT_CALL),
      ]),
    ).toEqual([
      `subagent.started ${SUBAGENT} parent=main item=${AGENT_CALL}`,
      `turn.started @${SUBAGENT}`,
      `item.started user_message id-4 @${SUBAGENT}`,
      `item.completed user_message id-4 completed @${SUBAGENT}`,
      `turn.completed completed @${SUBAGENT}`,
    ]);
  });

  it("ignores a task_notification for a subagent with no turn", () => {
    expect(
      normalizeMessages([
        buildTaskNotification(SUBAGENT, AGENT_CALL),
        buildTaskStarted(SUBAGENT, AGENT_CALL),
        buildTaskNotification(SUBAGENT, AGENT_CALL),
        buildTaskNotification(SUBAGENT, AGENT_CALL),
      ]).filter((line) => line.startsWith("turn.completed")),
    ).toEqual([`turn.completed completed @${SUBAGENT}`]);
  });

  it("opens a turn with no user message for a subagent that woke by itself", () => {
    const lines = normalizeMessages([
      buildTaskStarted(SUBAGENT, AGENT_CALL),
      buildSubagentText(AGENT_CALL, "msg_sub_1", "waiting for the build"),
      buildTaskNotification(SUBAGENT, AGENT_CALL),
      buildSubagentText(AGENT_CALL, "msg_sub_2", "the build passed"),
    ]);
    const woke = lines.slice(lines.indexOf(`turn.completed completed @${SUBAGENT}`) + 1);
    expect(woke).toEqual([
      `turn.started ${SUBAGENT_MODEL} @${SUBAGENT}`,
      `item.started assistant_message id-14 @${SUBAGENT}`,
      `content.delta assistant_text "the build passed" @${SUBAGENT}`,
      `item.completed assistant_message id-14 completed @${SUBAGENT}`,
    ]);
  });

  // After a stop, the stopped call's rejected tool_result arrives after the
  // task_notification that closed the turn. The result completes its item in
  // the turn the call started in and opens no turn, so the subagent does not
  // look running again.
  it("completes a trailing tool result of a stopped subagent in the turn the call started in", () => {
    const running = buildTestState();
    const lines = [
      buildTaskStarted(SUBAGENT, AGENT_CALL),
      buildSubagentToolUse(AGENT_CALL),
      buildTaskNotification(SUBAGENT, AGENT_CALL, "stopped"),
      buildSubagentToolResult(AGENT_CALL),
    ].flatMap((message) => normalize(running, message as unknown as SDKMessage).map(formatEvent));
    expect(lines.slice(-3)).toEqual([
      `item.started command_execution ${SUBAGENT_TOOL} @${SUBAGENT}`,
      `turn.completed interrupted @${SUBAGENT}`,
      `item.completed command_execution ${SUBAGENT_TOOL} completed @${SUBAGENT}`,
    ]);
    expect(isAnyAgentWorking(running)).toBe(false);
  });

  it("closes any turn a stopped subagent opens later, in the same call, as interrupted", () => {
    const running = buildTestState();
    for (const message of [
      buildTaskStarted(SUBAGENT, AGENT_CALL),
      buildSubagentText(AGENT_CALL, "msg_sub_1", "working"),
      buildTaskNotification(SUBAGENT, AGENT_CALL, "stopped"),
    ]) {
      normalize(running, message as unknown as SDKMessage);
    }
    const late = buildSubagentText(AGENT_CALL, "msg_sub_2", "one more thing");
    expect(normalize(running, late as unknown as SDKMessage).map(formatEvent)).toEqual([
      `turn.started ${SUBAGENT_MODEL} @${SUBAGENT}`,
      `item.started assistant_message id-14 @${SUBAGENT}`,
      `content.delta assistant_text "one more thing" @${SUBAGENT}`,
      `item.completed assistant_message id-14 completed @${SUBAGENT}`,
      `turn.completed interrupted @${SUBAGENT}`,
    ]);
    expect(isAnyAgentWorking(running)).toBe(false);
  });

  // stopTask may land after the subagent finished on its own, and then it
  // stopped nothing. The subagent must be stopped again if it works again.
  for (const status of ["completed", "failed"] as const) {
    it(`wants a sent stop again when the subagent's task_notification says ${status}`, () => {
      const running = buildTestState();
      normalize(running, buildTaskStarted(SUBAGENT, AGENT_CALL) as unknown as SDKMessage);
      running.subagents.byId.get(SUBAGENT)!.stop = "sent";
      normalize(
        running,
        buildTaskNotification(SUBAGENT, AGENT_CALL, status) as unknown as SDKMessage,
      );
      expect(running.subagents.byId.get(SUBAGENT)!.stop).toBe("wanted");
    });
  }

  // A stream event from a stopped subagent would open an item that no later
  // frame completes, because the turn it lands in closes at once.
  it("ignores stream events from a stopped subagent", () => {
    const running = buildTestState();
    for (const message of [
      buildTaskStarted(SUBAGENT, AGENT_CALL),
      buildSubagentText(AGENT_CALL, "msg_sub_1", "working"),
      buildTaskNotification(SUBAGENT, AGENT_CALL, "stopped"),
    ]) {
      normalize(running, message as unknown as SDKMessage);
    }
    for (const event of [
      { type: "message_start", message: { id: "msg_sub_2", model: SUBAGENT_MODEL } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ]) {
      const frame = {
        type: "stream_event",
        session_id: NATIVE,
        parent_tool_use_id: AGENT_CALL,
        event,
      };
      expect(normalize(running, frame as unknown as SDKMessage)).toEqual([]);
    }
    expect(isAnyAgentWorking(running)).toBe(false);
  });

  it("leaves a subagent's stream alone when the session's own agent's turn ends", () => {
    const buildSubagentStreamEvent = (event: unknown) => ({
      type: "stream_event",
      session_id: NATIVE,
      parent_tool_use_id: AGENT_CALL,
      event,
    });
    const lines = normalizeMessages([
      buildTaskStarted(SUBAGENT, AGENT_CALL),
      buildSubagentStreamEvent({
        type: "message_start",
        message: { id: "msg_sub_1", model: SUBAGENT_MODEL, role: "assistant" },
      }),
      buildSubagentStreamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      RESULT,
      buildSubagentStreamEvent({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "still here" },
      }),
    ]);
    expect(lines.at(-1)).toBe(`content.delta assistant_text "still here" @${SUBAGENT}`);
  });
});

describe("frames from a subagent not linked yet", () => {
  it("holds them back until task_started links their agent call, then emits them in order", () => {
    expect(
      normalizeMessages([
        buildSubagentText(AGENT_CALL, "msg_sub_1", "first"),
        buildSubagentText(AGENT_CALL, "msg_sub_2", "second"),
        buildTaskStarted(SUBAGENT, AGENT_CALL),
      ]),
    ).toEqual([
      `subagent.started ${SUBAGENT} parent=main item=${AGENT_CALL}`,
      `turn.started ${SUBAGENT_MODEL} @${SUBAGENT}`,
      `item.started user_message id-4 @${SUBAGENT}`,
      `item.completed user_message id-4 completed @${SUBAGENT}`,
      `item.started assistant_message id-7 @${SUBAGENT}`,
      `content.delta assistant_text "first" @${SUBAGENT}`,
      `item.completed assistant_message id-7 completed @${SUBAGENT}`,
      `item.started assistant_message id-11 @${SUBAGENT}`,
      `content.delta assistant_text "second" @${SUBAGENT}`,
      `item.completed assistant_message id-11 completed @${SUBAGENT}`,
    ]);
  });

  it("attaches each released frame's own payload to its events", () => {
    const running = buildTestState();
    const held = buildSubagentText(AGENT_CALL, "msg_sub_1", "first");
    expect(normalize(running, held as unknown as SDKMessage)).toEqual([]);
    const events = normalize(
      running,
      buildTaskStarted(SUBAGENT, AGENT_CALL) as unknown as SDKMessage,
    );
    const payloads = events.flatMap((event) =>
      event.raw === undefined ? [] : [event.raw.payload],
    );
    expect(payloads).toEqual([buildTaskStarted(SUBAGENT, AGENT_CALL), held]);
    const own = events.find(
      (event) => event._tag === "item.started" && event.kind === "assistant_message",
    );
    expect(own?.raw?.payload).toEqual(held);
  });

  // A task_started links one agent call only. The frames of another subagent
  // still wait for their own task_started, which can come later.
  it("keeps another subagent's frames held past a task_started, and releases them at its own", () => {
    const running = buildTestState();
    const held = [
      buildSubagentText(NESTED_CALL, "msg_nested_1", "first"),
      buildSubagentText(NESTED_CALL, "msg_nested_2", "second"),
    ];
    for (const message of held) {
      expect(normalize(running, message as unknown as SDKMessage)).toEqual([]);
    }
    expect(
      normalize(running, buildTaskStarted(SUBAGENT, AGENT_CALL) as unknown as SDKMessage).map(
        formatEvent,
      ),
    ).toEqual([`subagent.started ${SUBAGENT} parent=main item=${AGENT_CALL}`]);
    expect(running.heldFrames).toEqual(held);

    const lines = normalize(
      running,
      buildTaskStarted(NESTED, NESTED_CALL) as unknown as SDKMessage,
    ).map(formatEvent);
    expect(lines.filter((line) => line.startsWith("content.delta"))).toEqual([
      `content.delta assistant_text "first" @${NESTED}`,
      `content.delta assistant_text "second" @${NESTED}`,
    ]);
    expect(lines.some((line) => line.startsWith("runtime.warning"))).toBe(false);
    expect(running.heldFrames).toEqual([]);
  });

  it("releases only the frames a task_started links, and keeps the rest held in order", () => {
    const running = buildTestState();
    const own = [
      buildSubagentText(AGENT_CALL, "msg_sub_1", "first"),
      buildSubagentText(AGENT_CALL, "msg_sub_2", "second"),
    ];
    const other = [
      buildSubagentText(NESTED_CALL, "msg_nested_1", "other first"),
      buildSubagentText(NESTED_CALL, "msg_nested_2", "other second"),
    ];
    for (const message of [own[0], other[0], own[1], other[1]]) {
      normalize(running, message as unknown as SDKMessage);
    }
    const lines = normalize(
      running,
      buildTaskStarted(SUBAGENT, AGENT_CALL) as unknown as SDKMessage,
    ).map(formatEvent);
    expect(lines.filter((line) => line.startsWith("content.delta"))).toEqual([
      `content.delta assistant_text "first" @${SUBAGENT}`,
      `content.delta assistant_text "second" @${SUBAGENT}`,
    ]);
    expect(running.heldFrames).toEqual(other);
  });

  it("holds at most 1000 frames, and drops them all, with the requests of unknown subagents, at the next", () => {
    const running = buildTestState();
    deferUntilTurnOpens(
      running.subagents,
      "a-never-started",
      buildRequestOpened("r1", "a-never-started"),
    );
    normalize(running, buildTaskStarted(SUBAGENT, AGENT_CALL) as unknown as SDKMessage);
    deferUntilTurnOpens(running.subagents, SUBAGENT, buildRequestOpened("r2", SUBAGENT));
    const lost = buildSubagentText("toolu_01NeverStarted", "msg_lost", "lost");
    for (let held = 1; held <= 1000; held += 1) {
      expect(normalize(running, lost as unknown as SDKMessage)).toEqual([]);
    }
    const events = normalize(running, lost as unknown as SDKMessage);
    expect(
      events.map((event) => (event._tag === "runtime.warning" ? event.message : event._tag)),
    ).toEqual(["dropped 1001 messages from a subagent the harness never reported starting"]);
    expect(running.heldFrames).toEqual([]);
    // A known subagent's request still waits for its turn.
    expect([...running.subagents.waitingRequests.keys()]).toEqual([SUBAGENT]);
  });

  // The frames that would have opened the subagent's turn are gone, so a
  // request waiting for that turn could wait for ever.
  it("drops the waiting requests of a subagent whose frames were dropped, until its turn opens", () => {
    const running = buildTestState();
    const lost = buildSubagentText(AGENT_CALL, "msg_lost", "lost");
    for (let held = 1; held <= 1001; held += 1) normalize(running, lost as unknown as SDKMessage);
    // The request comes after the drop, while the subagent is still unknown.
    deferUntilTurnOpens(running.subagents, SUBAGENT, buildRequestOpened("r1", SUBAGENT));

    normalize(running, buildTaskStarted(SUBAGENT, AGENT_CALL) as unknown as SDKMessage);
    expect(running.subagents.waitingRequests.has(SUBAGENT)).toBe(false);
    expect(running.subagents.byId.get(SUBAGENT)?.openingFramesLost).toBe(true);

    // The subagent's next frame opens its turn, and its requests work again.
    normalize(running, buildSubagentText(AGENT_CALL, "msg_sub_1", "back") as unknown as SDKMessage);
    expect(running.subagents.byId.get(SUBAGENT)?.openingFramesLost).toBe(false);
    expect(
      deferUntilTurnOpens(running.subagents, SUBAGENT, buildRequestOpened("r2", SUBAGENT)),
    ).toHaveLength(1);
  });

  it("does not mark a subagent whose frames were never dropped", () => {
    const running = buildTestState();
    const lost = buildSubagentText("toolu_01NeverStarted", "msg_lost", "lost");
    for (let held = 1; held <= 1001; held += 1) normalize(running, lost as unknown as SDKMessage);
    normalize(running, buildTaskStarted(SUBAGENT, AGENT_CALL) as unknown as SDKMessage);
    expect(running.subagents.byId.get(SUBAGENT)?.openingFramesLost).toBe(false);
  });
});

describe("introducing a subagent", () => {
  it("leaves out a description and an agent type that are missing or empty", () => {
    const running = buildTestState();
    const started: Record<string, unknown> = {
      ...buildTaskStarted(SUBAGENT, AGENT_CALL),
      subagent_type: "",
    };
    delete started["description"];
    const [introduced] = normalize(running, started as unknown as SDKMessage);
    expect(introduced).toMatchObject({ _tag: "subagent.started", subagentId: SUBAGENT });
    expect(introduced).not.toHaveProperty("description");
    expect(introduced).not.toHaveProperty("agentType");
  });

  it("warns once, at the subagent's start, that its id was changed to fit the protocol", () => {
    const running = buildTestState();
    const started = normalize(
      running,
      buildTaskStarted("agent:1", AGENT_CALL) as unknown as SDKMessage,
    );
    expect(started.map(formatEvent)).toEqual([
      `subagent.started agent_1 parent=main item=${AGENT_CALL}`,
      "runtime.warning @agent_1",
    ]);
    const warned = started.at(-1);
    expect(warned?._tag === "runtime.warning" ? warned.message : undefined).toBe(
      'the harness named a subagent "agent:1", which the protocol does not accept, so it is reported as "agent_1"',
    );
    const later = [
      buildTaskNotification("agent:1", AGENT_CALL),
      buildTaskStarted("agent:1", AGENT_CALL),
    ].flatMap((message) => normalize(running, message as unknown as SDKMessage));
    expect(later.some((event) => event._tag === "runtime.warning")).toBe(false);
  });

  it("replaces a colon in a SubagentId, which the protocol does not accept", () => {
    const running = buildTestState();
    const [introduced] = normalize(
      running,
      buildTaskStarted("agent:1", AGENT_CALL) as unknown as SDKMessage,
    );
    expect(introduced).toMatchObject({ _tag: "subagent.started", subagentId: "agent_1" });
    const events = normalize(
      running,
      buildTaskNotification("agent:1", AGENT_CALL) as unknown as SDKMessage,
    );
    expect(events.map(formatEvent).at(-1)).toBe("turn.completed completed @agent_1");
  });
});

describe("a malformed frame from a subagent", () => {
  it("becomes an unknown item in the subagent's turn rather than throwing", () => {
    const running = buildTestState();
    normalize(running, buildTaskStarted(SUBAGENT, AGENT_CALL) as unknown as SDKMessage);
    const broken = {
      type: "assistant",
      session_id: NATIVE,
      parent_tool_use_id: AGENT_CALL,
      message: { id: "msg_broken" },
    };
    expect(
      normalize(running, broken as unknown as SDKMessage)
        .map(formatEvent)
        .map((line) => line.replace(/ id-\d+/, "")),
    ).toEqual([
      `turn.started @${SUBAGENT}`,
      `item.started user_message @${SUBAGENT}`,
      `item.completed user_message completed @${SUBAGENT}`,
      `item.started unknown @${SUBAGENT}`,
      `item.completed unknown completed @${SUBAGENT}`,
    ]);
  });
});

describe("a resumed session's subagents", () => {
  const SEEDED: ReadonlyArray<ContinuedSubagent> = [
    { subagentId: SUBAGENT, itemId: AGENT_CALL, parentSubagentId: "a0parent00000000" },
  ];

  it("routes a known subagent's frames to it, introducing it first with its recorded parent", () => {
    expect(
      normalizeMessages(
        [buildSubagentText(AGENT_CALL, "msg_sub_1", "back again")],
        buildTestState(undefined, SEEDED),
      ),
    ).toEqual([
      `subagent.started ${SUBAGENT} parent=a0parent00000000 item=${AGENT_CALL}`,
      `turn.started ${SUBAGENT_MODEL} @${SUBAGENT}`,
      `item.started assistant_message id-4 @${SUBAGENT}`,
      `content.delta assistant_text "back again" @${SUBAGENT}`,
      `item.completed assistant_message id-4 completed @${SUBAGENT}`,
    ]);
  });

  it("attaches the frame's payload to the frame's own item, not to the introduction", () => {
    const frame = buildSubagentText(AGENT_CALL, "msg_sub_1", "back again");
    const events = normalize(buildTestState(undefined, SEEDED), frame as SDKMessage);
    expect(events.filter((event) => event.raw !== undefined).map((event) => event._tag)).toEqual([
      "item.started",
    ]);
  });

  it("introduces a known subagent once, at the task_started that continues it", () => {
    const lines = normalizeMessages(
      [
        buildTaskStarted(SUBAGENT, AGENT_CALL),
        buildSubagentText(AGENT_CALL, "msg_sub_1", "back again"),
      ],
      buildTestState(undefined, SEEDED),
    );
    expect(lines.filter((line) => line.startsWith("subagent.started"))).toEqual([
      `subagent.started ${SUBAGENT} parent=a0parent00000000 item=${AGENT_CALL}`,
    ]);
  });
});

describe("a subagent's tool calls and denials", () => {
  const buildSendMessage = (to: string) => ({
    type: "assistant",
    uuid: "uuid-send",
    session_id: NATIVE,
    parent_tool_use_id: null,
    message: {
      id: "msg_send",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_01Send",
          name: "SendMessage",
          input: { to, message: "also check tests" },
        },
      ],
    },
  });

  const readSendMessageDetail = (to: string): unknown => {
    const running = buildTestState();
    const events = [
      buildAgentCall(null, AGENT_CALL, "finder"),
      buildTaskStarted(SUBAGENT, AGENT_CALL),
      buildSendMessage(to),
    ].flatMap((message) => normalize(running, message as unknown as SDKMessage));
    const sent = events.find(
      (event) => event._tag === "item.started" && event.itemId === "toolu_01Send",
    );
    return sent?._tag === "item.started" ? { kind: sent.kind, detail: sent.detail } : undefined;
  };

  it("makes SendMessage a subagent item that lists the subagent its `to` names", () => {
    const input = { to: SUBAGENT, message: "also check tests" };
    expect(readSendMessageDetail(SUBAGENT)).toEqual({
      kind: "subagent",
      detail: { name: "SendMessage", input, subagentIds: [SUBAGENT] },
    });
    expect(readSendMessageDetail("finder")).toEqual({
      kind: "subagent",
      detail: { name: "SendMessage", input: { ...input, to: "finder" }, subagentIds: [SUBAGENT] },
    });
    expect(readSendMessageDetail("stranger")).toEqual({
      kind: "subagent",
      detail: { name: "SendMessage", input: { ...input, to: "stranger" } },
    });
  });

  // The denied tool item already ends failed when its `tool_result` arrives,
  // so the denial itself is dropped, whichever agent it names.
  it("drops a permission denial, and it opens no turn for any agent", () => {
    const buildPermissionDenied = (agentId: string | undefined) => ({
      type: "system",
      subtype: "permission_denied",
      tool_name: "Write",
      tool_use_id: SUBAGENT_TOOL,
      ...(agentId === undefined ? {} : { agent_id: agentId }),
      decision_reason_type: "mode",
      message: "Permission to use Write has been denied.",
      uuid: "uuid-denied",
      session_id: NATIVE,
    });
    const running = buildTestState();
    normalize(running, buildTaskStarted(SUBAGENT, AGENT_CALL) as unknown as SDKMessage);
    for (const agentId of [undefined, SUBAGENT, "a0unknown0000000"]) {
      expect(normalize(running, buildPermissionDenied(agentId) as unknown as SDKMessage)).toEqual(
        [],
      );
    }
    expect(running.heldFrames).toEqual([]);
    expect(running.turnId).toBeUndefined();
  });
});

describe("a subagent's requests", () => {
  it("defers a request until the subagent's turn opens, then emits it right after the opening", () => {
    const running = buildTestState();
    normalize(running, buildTaskStarted(SUBAGENT, AGENT_CALL) as unknown as SDKMessage);
    expect(
      deferUntilTurnOpens(running.subagents, SUBAGENT, buildRequestOpened("r1", SUBAGENT)),
    ).toEqual([]);
    const lines = normalize(
      running,
      buildSubagentToolUse(AGENT_CALL, "Write") as unknown as SDKMessage,
    ).map(formatEvent);
    expect(lines).toEqual([
      `turn.started ${SUBAGENT_MODEL} @${SUBAGENT}`,
      `item.started user_message id-4 @${SUBAGENT}`,
      `item.completed user_message id-4 completed @${SUBAGENT}`,
      `request.opened @${SUBAGENT}`,
      `item.started file_change ${SUBAGENT_TOOL} @${SUBAGENT}`,
    ]);
  });

  it("returns a request at once while the subagent's turn is open", () => {
    const running = buildTestState();
    for (const message of [
      buildTaskStarted(SUBAGENT, AGENT_CALL),
      buildSubagentToolUse(AGENT_CALL),
    ]) {
      normalize(running, message as unknown as SDKMessage);
    }
    const opened = buildRequestOpened("r1", SUBAGENT);
    expect(deferUntilTurnOpens(running.subagents, SUBAGENT, opened)).toEqual([opened]);
  });

  // Claude Code asks as soon as it reads the tool call, which can be before
  // the runner has normalized the task_started that names the subagent.
  it("defers a request from a subagent the registry does not know yet", () => {
    const running = buildTestState();
    expect(
      deferUntilTurnOpens(running.subagents, SUBAGENT, buildRequestOpened("r1", SUBAGENT)),
    ).toEqual([]);
    const lines = [
      buildTaskStarted(SUBAGENT, AGENT_CALL),
      buildSubagentToolUse(AGENT_CALL),
    ].flatMap((message) => normalize(running, message as unknown as SDKMessage).map(formatEvent));
    expect(lines).toContain(`request.opened @${SUBAGENT}`);
  });
});

describe("whether any agent is working", () => {
  it("counts the session's own agent's turn and every subagent's open or pending turn", () => {
    const running = buildTestState();
    expect(isAnyAgentWorking(running)).toBe(false);
    normalize(running, buildTaskStarted(SUBAGENT, AGENT_CALL) as unknown as SDKMessage);
    expect(isAnyAgentWorking(running)).toBe(true);
    normalize(running, buildTaskNotification(SUBAGENT, AGENT_CALL) as unknown as SDKMessage);
    expect(isAnyAgentWorking(running)).toBe(false);
    normalize(running, ASSISTANT_TOOL_USE as unknown as SDKMessage);
    expect(isAnyAgentWorking(running)).toBe(true);
  });
});

describe("encoding a subagent's events with the protocol schema", () => {
  it("encodes every event a subagent's life produces", () => {
    const encode = Schema.encodeUnknownSync(ProviderEvent);
    const running = buildTestState();
    const messages = [
      buildAgentCall(null, AGENT_CALL, "finder"),
      buildTaskStarted(SUBAGENT, AGENT_CALL),
      buildSubagentPrompt(AGENT_CALL),
      buildSubagentToolUse(AGENT_CALL),
      buildSubagentToolResult(AGENT_CALL),
      buildAgentCall(AGENT_CALL, NESTED_CALL),
      buildTaskStarted(NESTED, NESTED_CALL),
      buildSubagentText(NESTED_CALL, "msg_nested_1", "nested"),
      buildTaskNotification(NESTED, NESTED_CALL),
      buildTaskNotification(SUBAGENT, AGENT_CALL, "stopped"),
    ];
    for (const message of messages) {
      for (const event of normalize(running, message as unknown as SDKMessage)) {
        expect(() => encode(event)).not.toThrow();
      }
    }
  });
});

describe("two agents streaming at once", () => {
  const buildAgentStreamEvent = (parent: string | null, event: unknown) => ({
    type: "stream_event",
    session_id: NATIVE,
    parent_tool_use_id: parent,
    event,
  });

  const buildMessageStart = (id: string) => ({
    type: "message_start",
    message: { id, model: "claude-haiku-4-5-20251001", role: "assistant" },
  });

  const text = { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };

  it("keeps the session's own agent's blocks apart from a subagent's", () => {
    expect(
      normalizeMessages([
        buildTaskStarted(SUBAGENT, AGENT_CALL),
        buildAgentStreamEvent(null, buildMessageStart("msg_main")),
        buildAgentStreamEvent(null, text),
        buildAgentStreamEvent(AGENT_CALL, buildMessageStart("msg_sub")),
        buildAgentStreamEvent(AGENT_CALL, text),
        buildAgentStreamEvent(null, {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "from the main loop" },
        }),
        buildAgentStreamEvent(null, { type: "content_block_stop", index: 0 }),
      ]),
    ).toEqual([
      `subagent.started ${SUBAGENT} parent=main item=${AGENT_CALL}`,
      "turn.started",
      "item.started assistant_message msg_main#0",
      // A turn a stream opens carries the model `message_start` named.
      `turn.started claude-haiku-4-5-20251001 @${SUBAGENT}`,
      `item.started user_message id-7 @${SUBAGENT}`,
      `item.completed user_message id-7 completed @${SUBAGENT}`,
      `item.started assistant_message msg_sub#0 @${SUBAGENT}`,
      'content.delta assistant_text "from the main loop"',
      "item.completed assistant_message msg_main#0 completed",
    ]);
  });
});

describe("a tool result too large for one frame", () => {
  /** The size of a 1.2 MiB PNG once the SDK has written it as base64. */
  const IMAGE_BASE64_LENGTH = 1.6 * 1024 * 1024;

  /** What the SDK reports after `Read` opens a large PNG: the image as a base64 block. */
  const IMAGE_RESULT = {
    ...TOOL_RESULT,
    message: {
      role: "user",
      content: [
        {
          tool_use_id: TOOL,
          type: "tool_result",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "A".repeat(IMAGE_BASE64_LENGTH),
              },
            },
          ],
        },
      ],
    },
  };

  const measureEventBytes = (event: Event): number =>
    measureFrameBytes({ _tag: "sessionEvent", seq: 1, event });

  // Before sending, the supervisor shrinks an event like this one to fit in a
  // frame. The tests in sessions/fit-event.test.ts cover that step.
  it("is normalized to an item.completed larger than a frame", () => {
    const running = buildTestState();
    normalize(running, ASSISTANT_TOOL_USE as unknown as SDKMessage);
    const events = normalize(running, IMAGE_RESULT as unknown as SDKMessage);
    const completed = events.find((event) => event._tag === "item.completed");

    // The image is in `detail` and again in `raw`, so the frame would close
    // the runner's socket.
    expect(completed).toBeDefined();
    expect(measureEventBytes(completed!)).toBeGreaterThan(MAX_FRAME_BYTES);
  });
});

describe("server tool, MCP tool and result blocks", () => {
  const SERVER_TOOL = "srvtoolu_01WebSearch000000000001";
  const MCP_TOOL = "mcptoolu_01LinearIssues0000001";

  const encode = Schema.encodeUnknownSync(ProviderEvent);

  /** Builds an assistant message that holds the given content blocks. */
  const buildBlocks = (content: ReadonlyArray<unknown>, id = MESSAGE) => ({
    type: "assistant",
    uuid: "4c6485ca-097a-43f5-8709-6865c49705ca",
    session_id: NATIVE,
    parent_tool_use_id: null,
    message: { id, role: "assistant", model: "claude-sonnet-5-5", content },
  });

  const buildServerToolUse = (name: string, input: unknown, id = SERVER_TOOL) => ({
    type: "server_tool_use",
    id,
    name,
    input,
  });

  const SEARCH_HITS = [
    {
      type: "web_search_result",
      title: "Schema - Effect Documentation",
      url: "https://effect.website/docs/schema/",
      page_age: "3 weeks ago",
      encrypted_content: "EqgfCioIAhgBIiQ4YjZk",
    },
    {
      type: "web_search_result",
      title: "Union | Effect Schema",
      url: "https://effect.website/docs/schema/unions/",
      page_age: null,
      encrypted_content: "EpYCCioIAhgBIiQ0Y2U1",
    },
  ];

  /** Normalizes the messages in order, in one state, and returns every event. */
  const run = (
    messages: ReadonlyArray<unknown>,
    running = buildTestState(),
  ): ReadonlyArray<Event> =>
    messages.flatMap((message) => normalize(running, message as SDKMessage));

  /** Returns the events of one kind of item. */
  const listItemEvents = (
    events: ReadonlyArray<Event>,
    tag: "item.started" | "item.completed",
    kind: string,
  ) => events.flatMap((event) => (event._tag === tag && event.kind === kind ? [event] : []));

  /** Returns the one `item.completed` for an item id. */
  const readCompleted = (events: ReadonlyArray<Event>, itemId: string) => {
    const found = events.filter(
      (event) => event._tag === "item.completed" && event.itemId === itemId,
    );
    expect(found).toHaveLength(1);
    const [event] = found;
    return event?._tag === "item.completed"
      ? { status: event.status, detail: event.detail as Record<string, unknown> }
      : undefined;
  };

  describe("a server web search", () => {
    const events = run([
      buildBlocks([buildServerToolUse("web_search", { query: "effect schema unions" })]),
      buildBlocks([
        { type: "web_search_tool_result", tool_use_id: SERVER_TOOL, content: SEARCH_HITS },
      ]),
    ]);

    it("is one web_search item with the query beside the name and the input", () => {
      expect(listItemEvents(events, "item.started", "web_search")).toHaveLength(1);
      const started = listItemEvents(events, "item.started", "web_search")[0];
      expect(started?.detail).toEqual({
        name: "web_search",
        input: { query: "effect schema unions" },
        query: "effect schema unions",
      });
    });

    it("completes with a title and URL for each result and no encrypted content", () => {
      const completed = readCompleted(events, SERVER_TOOL);
      expect(completed?.status).toBe("completed");
      expect(completed?.detail["content"]).toBe(
        [
          "Schema - Effect Documentation",
          "https://effect.website/docs/schema/",
          "",
          "Union | Effect Schema",
          "https://effect.website/docs/schema/unions/",
        ].join("\n"),
      );
      expect(JSON.stringify(completed?.detail)).not.toContain("EqgfCioIAhgBIiQ4YjZk");
    });

    it("keeps the whole vendor message in raw", () => {
      const raw = events.find((event) => event._tag === "item.completed")?.raw;
      expect(JSON.stringify(raw)).toContain("EqgfCioIAhgBIiQ4YjZk");
    });

    it("encodes with the protocol schema", () => {
      for (const event of events) expect(() => encode(event)).not.toThrow();
    });
  });

  it("shows a server web fetch as a web_search item with the url", () => {
    const events = run([
      buildBlocks([buildServerToolUse("web_fetch", { url: "https://example.com/a" })]),
      buildBlocks([
        {
          type: "web_fetch_tool_result",
          tool_use_id: SERVER_TOOL,
          content: {
            type: "web_fetch_result",
            url: "https://example.com/a",
            retrieved_at: null,
            content: {
              type: "document",
              title: "Example A",
              citations: null,
              source: { type: "text", media_type: "text/plain", data: "Hello page" },
            },
          },
        },
      ]),
    ]);
    expect(listItemEvents(events, "item.started", "web_search")[0]?.detail).toEqual({
      name: "web_fetch",
      input: { url: "https://example.com/a" },
      url: "https://example.com/a",
    });
    expect(readCompleted(events, SERVER_TOOL)?.detail["content"]).toBe(
      "Example A\nhttps://example.com/a\n\nHello page",
    );
  });

  it("cuts the text of a fetched page and names a PDF instead of showing it", () => {
    const fetchResult = (source: unknown) =>
      buildBlocks([
        {
          type: "web_fetch_tool_result",
          tool_use_id: SERVER_TOOL,
          content: {
            type: "web_fetch_result",
            url: "https://example.com/b",
            retrieved_at: null,
            content: { type: "document", title: null, citations: null, source },
          },
        },
      ]);
    const long = readCompleted(
      run([
        buildBlocks([buildServerToolUse("web_fetch", { url: "https://example.com/b" })]),
        fetchResult({ type: "text", media_type: "text/plain", data: "x".repeat(10_000) }),
      ]),
      SERVER_TOOL,
    );
    expect(String(long?.detail["content"]).length).toBeLessThan(2_100);
    expect(String(long?.detail["content"])).toContain("…");
    const pdf = readCompleted(
      run([
        buildBlocks([buildServerToolUse("web_fetch", { url: "https://example.com/b" })]),
        fetchResult({ type: "base64", media_type: "application/pdf", data: "JVBERi0=" }),
      ]),
      SERVER_TOOL,
    );
    expect(pdf?.detail["content"]).toBe("https://example.com/b\n\nThe page is a PDF document.");
  });

  it("shows any other server tool as a native tool_call", () => {
    const events = run([buildBlocks([buildServerToolUse("code_execution", { code: "print(1)" })])]);
    expect(listItemEvents(events, "item.started", "tool_call")[0]?.detail).toEqual({
      name: "code_execution",
      input: { code: "print(1)" },
      kind: "native",
    });
  });

  it("never classifies a server tool by the local tool names", () => {
    // `Bash` is a local command; a server tool of the same name must not read as one.
    const events = run([buildBlocks([buildServerToolUse("Bash", { command: "rm -rf /" })])]);
    expect(listItemEvents(events, "item.started", "command_execution")).toEqual([]);
    expect(listItemEvents(events, "item.started", "tool_call")).toHaveLength(1);
  });

  describe("an MCP call", () => {
    const call = buildBlocks([
      {
        type: "mcp_tool_use",
        id: MCP_TOOL,
        name: "list_issues",
        server_name: "linear",
        input: { n: 3 },
      },
    ]);
    const buildMcpResult = (content: unknown, isError: boolean) =>
      buildBlocks([{ type: "mcp_tool_result", tool_use_id: MCP_TOOL, content, is_error: isError }]);

    it("is a tool_call with kind mcp and the server's name", () => {
      const events = run([call]);
      expect(listItemEvents(events, "item.started", "tool_call")[0]?.detail).toEqual({
        name: "list_issues",
        input: { n: 3 },
        kind: "mcp",
        server: "linear",
      });
    });

    it("completes with the text the server returned", () => {
      const completed = readCompleted(run([call, buildMcpResult("3 issues", false)]), MCP_TOOL);
      expect(completed).toEqual({ status: "completed", detail: { content: "3 issues" } });
    });

    it("fails when the server flagged an error, and keeps a list of text blocks as it is", () => {
      const blocks = [{ type: "text", text: "no access", citations: null }];
      const completed = readCompleted(run([call, buildMcpResult(blocks, true)]), MCP_TOOL);
      expect(completed).toEqual({ status: "failed", detail: { content: blocks } });
    });
  });

  describe("each other result block", () => {
    /** Runs a server call and its result, and returns what the item completed with. */
    const complete = (toolName: string, content: unknown, resultType: string) =>
      readCompleted(
        run([
          buildBlocks([buildServerToolUse(toolName, {})]),
          buildBlocks([{ type: resultType, tool_use_id: SERVER_TOOL, content }]),
        ]),
        SERVER_TOOL,
      );

    const cases: ReadonlyArray<
      readonly [name: string, tool: string, type: string, content: unknown, text: string]
    > = [
      [
        "code execution",
        "code_execution",
        "code_execution_tool_result",
        {
          type: "code_execution_result",
          stdout: "42\n",
          stderr: "warn",
          return_code: 0,
          content: [],
        },
        "Return code: 0\nOutput:\n42\n\nError output:\nwarn",
      ],
      [
        "encrypted code execution",
        "code_execution",
        "code_execution_tool_result",
        {
          type: "encrypted_code_execution_result",
          encrypted_stdout: "ZW5jcnlwdGVk",
          stderr: "",
          return_code: 0,
          content: [],
        },
        "Return code: 0\nThe output is encrypted.",
      ],
      [
        "bash code execution",
        "bash_code_execution",
        "bash_code_execution_tool_result",
        {
          type: "bash_code_execution_result",
          stdout: "hi",
          stderr: "",
          return_code: 0,
          content: [],
        },
        "Return code: 0\nOutput:\nhi",
      ],
      [
        "text editor view",
        "text_editor_code_execution",
        "text_editor_code_execution_tool_result",
        {
          type: "text_editor_code_execution_view_result",
          content: "line one",
          file_type: "text",
          num_lines: 1,
          start_line: 1,
          total_lines: 1,
        },
        "line one",
      ],
      [
        "text editor create",
        "text_editor_code_execution",
        "text_editor_code_execution_tool_result",
        { type: "text_editor_code_execution_create_result", is_file_update: false },
        "The file was created.",
      ],
      [
        "text editor replace",
        "text_editor_code_execution",
        "text_editor_code_execution_tool_result",
        {
          type: "text_editor_code_execution_str_replace_result",
          lines: ["-old", "+new"],
          new_lines: 1,
          new_start: 3,
          old_lines: 1,
          old_start: 3,
        },
        "-old\n+new",
      ],
      [
        "tool search",
        "tool_search_tool_regex",
        "tool_search_tool_result",
        {
          type: "tool_search_tool_search_result",
          tool_references: [
            { type: "tool_reference", tool_name: "get_weather" },
            { type: "tool_reference", tool_name: "get_time" },
          ],
        },
        "Found tools: get_weather, get_time",
      ],
      [
        "advisor",
        "advisor",
        "advisor_tool_result",
        { type: "advisor_result", stop_reason: "end_turn", text: "Take the smaller step." },
        "Take the smaller step.",
      ],
      [
        "redacted advisor",
        "advisor",
        "advisor_tool_result",
        { type: "advisor_redacted_result", stop_reason: null, encrypted_content: "abc" },
        "The advice is encrypted.",
      ],
    ];

    for (const [name, tool, type, content, text] of cases) {
      it(`completes a ${name} call with readable text`, () => {
        expect(complete(tool, content, type)).toEqual({
          status: "completed",
          detail: { content: text },
        });
      });
    }

    const failedRuns: ReadonlyArray<
      readonly [name: string, tool: string, type: string, content: unknown, text: string]
    > = [
      [
        "code execution",
        "code_execution",
        "code_execution_tool_result",
        {
          type: "code_execution_result",
          stdout: "partial",
          stderr: "boom",
          return_code: 2,
          content: [],
        },
        "Return code: 2\nOutput:\npartial\nError output:\nboom",
      ],
      [
        "encrypted code execution",
        "code_execution",
        "code_execution_tool_result",
        {
          type: "encrypted_code_execution_result",
          encrypted_stdout: "ZW5jcnlwdGVk",
          stderr: "",
          return_code: 1,
          content: [],
        },
        "Return code: 1\nThe output is encrypted.",
      ],
      [
        "bash code execution",
        "bash_code_execution",
        "bash_code_execution_tool_result",
        {
          type: "bash_code_execution_result",
          stdout: "",
          stderr: "no such file",
          return_code: 127,
          content: [],
        },
        "Return code: 127\nError output:\nno such file",
      ],
    ];

    for (const [name, tool, type, content, text] of failedRuns) {
      it(`fails a ${name} call with a non-zero return code and keeps the output readable`, () => {
        expect(complete(tool, content, type)).toEqual({
          status: "failed",
          detail: { content: text },
        });
      });
    }

    const errors: ReadonlyArray<
      readonly [name: string, tool: string, type: string, errorType: string, text: string]
    > = [
      [
        "web search",
        "web_search",
        "web_search_tool_result",
        "web_search_tool_result_error",
        "The web search failed: max_uses_exceeded",
      ],
      [
        "web fetch",
        "web_fetch",
        "web_fetch_tool_result",
        "web_fetch_tool_result_error",
        "The web fetch failed: max_uses_exceeded",
      ],
      [
        "code execution",
        "code_execution",
        "code_execution_tool_result",
        "code_execution_tool_result_error",
        "The code execution failed: max_uses_exceeded",
      ],
      [
        "advisor",
        "advisor",
        "advisor_tool_result",
        "advisor_tool_result_error",
        "The advisor failed: max_uses_exceeded",
      ],
    ];

    for (const [name, tool, type, errorType, text] of errors) {
      it(`fails a ${name} call whose result is an error, and names the error code`, () => {
        expect(complete(tool, { type: errorType, error_code: "max_uses_exceeded" }, type)).toEqual({
          status: "failed",
          detail: { content: text },
        });
      });
    }
  });

  describe("a result whose call was never seen", () => {
    it("starts and completes a web_search item of its own, in the current turn", () => {
      const running = buildTestState();
      const lines = run(
        [
          buildBlocks([
            { type: "web_search_tool_result", tool_use_id: SERVER_TOOL, content: SEARCH_HITS },
          ]),
        ],
        running,
      ).map(formatEvent);
      expect(lines).toEqual([
        "turn.started",
        `item.started web_search ${SERVER_TOOL}`,
        `item.completed web_search ${SERVER_TOOL} completed`,
      ]);
    });

    it("starts and completes a tool_call of its own for a result block of another tool", () => {
      const lines = run([
        buildBlocks([
          { type: "mcp_tool_result", tool_use_id: MCP_TOOL, content: "ok", is_error: false },
        ]),
      ]).map(formatEvent);
      expect(lines).toEqual([
        "turn.started",
        `item.started tool_call ${MCP_TOOL}`,
        `item.completed tool_call ${MCP_TOOL} completed`,
      ]);
    });

    it("does the same for a tool_result of a user message", () => {
      const running = buildTestState();
      const lines = run([TOOL_RESULT], running).map(formatEvent);
      expect(lines).toEqual([
        "turn.started",
        `item.started tool_call ${TOOL}`,
        `item.completed tool_call ${TOOL} completed`,
        "turn.completed completed",
      ]);
    });
  });

  describe("a fetched page whose call was never seen", () => {
    const pageResult = (content: unknown) =>
      buildBlocks([{ type: "web_fetch_tool_result", tool_use_id: SERVER_TOOL, content }]);

    it("opens a web_search item with the fetched url, which a client draws as a page fetch", () => {
      const events = run([
        pageResult({
          type: "web_fetch_result",
          url: "https://example.com/a",
          retrieved_at: null,
          content: {
            type: "document",
            title: null,
            citations: null,
            source: { type: "text", media_type: "text/plain", data: "Hello page" },
          },
        }),
      ]);
      expect(listItemEvents(events, "item.started", "web_search")[0]?.detail).toEqual({
        name: "web_fetch",
        url: "https://example.com/a",
      });
      expect(readCompleted(events, SERVER_TOOL)?.status).toBe("completed");
    });

    it("opens a native tool_call named web_fetch for an error, which holds no url", () => {
      const events = run([
        pageResult({ type: "web_fetch_tool_result_error", error_code: "url_not_accessible" }),
      ]);
      expect(listItemEvents(events, "item.started", "web_search")).toEqual([]);
      expect(listItemEvents(events, "item.started", "tool_call")[0]?.detail).toEqual({
        name: "web_fetch",
        kind: "native",
      });
      expect(readCompleted(events, SERVER_TOOL)).toEqual({
        status: "failed",
        detail: { content: "The web fetch failed: url_not_accessible" },
      });
    });
  });

  describe("a result in a shape the SDK does not promise", () => {
    /** The bodies of results that read as success before: an unknown nested type, or a missing field. */
    const unreadable: ReadonlyArray<readonly [name: string, type: string, content: unknown]> = [
      [
        "a text editor result of an unknown type",
        "text_editor_code_execution_tool_result",
        { type: "text_editor_code_execution_delete_result" },
      ],
      [
        "a text editor view without text",
        "text_editor_code_execution_tool_result",
        { type: "text_editor_code_execution_view_result" },
      ],
      ["a search hit with no title or URL", "web_search_tool_result", [{}]],
      [
        "a code execution result of an unknown type",
        "code_execution_tool_result",
        { type: "code_execution_tomorrow_result", return_code: 0, stdout: "", stderr: "" },
      ],
      [
        "a code execution result with no return code",
        "code_execution_tool_result",
        { type: "code_execution_result", stdout: "", stderr: "" },
      ],
      [
        "a bash result with no output",
        "bash_code_execution_tool_result",
        { type: "bash_code_execution_result", return_code: 0, stderr: "" },
      ],
      [
        "a fetched page with an unknown source",
        "web_fetch_tool_result",
        {
          type: "web_fetch_result",
          url: "https://example.com/a",
          content: { type: "document", title: null, source: { type: "hologram" } },
        },
      ],
      ["an advisor result of an unknown type", "advisor_tool_result", { type: "advisor_whisper" }],
      ["a tool search with no references", "tool_search_tool_result", { type: "x" }],
      [
        "an error with no error code",
        "web_search_tool_result",
        { type: "web_search_tool_result_error" },
      ],
    ];

    for (const [name, type, content] of unreadable) {
      it(`fails the running call for ${name}`, () => {
        const { running, reports } = buildReportingState();
        const events = run(
          [
            buildBlocks([buildServerToolUse("server_thing", {})]),
            buildBlocks([{ type, tool_use_id: SERVER_TOOL, content }]),
          ],
          running,
        );
        expect(readCompleted(events, SERVER_TOOL)?.status).toBe("failed");
        expect(reports).toHaveLength(1);
      });

      it(`labels ${name} as an unknown item when the call was never seen`, () => {
        const { running, reports } = buildReportingState();
        const events = run([buildBlocks([{ type, tool_use_id: SERVER_TOOL, content }])], running);
        expect(listItemEvents(events, "item.started", "unknown")).toHaveLength(1);
        expect(listItemEvents(events, "item.completed", "web_search")).toEqual([]);
        expect(listItemEvents(events, "item.completed", "tool_call")).toEqual([]);
        expect(reports).toHaveLength(1);
      });
    }
  });

  it("leaves no open tool behind when a call block cannot be read", () => {
    // `server_name` is not text, so the call throws while its item is built.
    const { running } = buildReportingState();
    const events = run(
      [
        buildBlocks([
          { type: "mcp_tool_use", id: MCP_TOOL, name: "list_issues", server_name: null, input: {} },
        ]),
        buildBlocks([
          { type: "mcp_tool_result", tool_use_id: MCP_TOOL, content: "3 issues", is_error: false },
        ]),
      ],
      running,
    );
    expect(running.tools.size).toBe(0);
    // The call shows as an unknown item. The result becomes an orphan, which
    // starts before it completes, so no completion lacks its start.
    expect(listItemEvents(events, "item.started", "unknown")).toHaveLength(1);
    expect(
      listItemEvents(events, "item.started", "tool_call").map((event) => event.itemId),
    ).toEqual([MCP_TOOL]);
    expect(readCompleted(events, MCP_TOOL)).toEqual({
      status: "completed",
      detail: { content: "3 issues" },
    });
  });

  it("completes a late result in the turn its call started in", () => {
    const running = buildTestState();
    const events = run(
      [
        buildBlocks([buildServerToolUse("web_search", { query: "q" })]),
        RESULT,
        buildBlocks([
          { type: "web_search_tool_result", tool_use_id: SERVER_TOOL, content: SEARCH_HITS },
        ]),
      ],
      running,
    );
    const started = listItemEvents(events, "item.started", "web_search")[0];
    const completed = listItemEvents(events, "item.completed", "web_search")[0];
    expect(completed?.turnId).toBe(started?.turnId);
    // The result opened no turn of its own.
    expect(events.filter((event) => event._tag === "turn.started")).toHaveLength(1);
    expect(running.turnId).toBeUndefined();
  });

  it("completes a subagent's late result as the subagent's, in its starting turn", () => {
    const running = buildTestState();
    const events = run(
      [
        buildTaskStarted(SUBAGENT, AGENT_CALL),
        {
          ...buildBlocks([buildServerToolUse("web_search", { query: "q" })]),
          parent_tool_use_id: AGENT_CALL,
        },
        {
          ...buildBlocks([
            { type: "web_search_tool_result", tool_use_id: SERVER_TOOL, content: SEARCH_HITS },
          ]),
          parent_tool_use_id: AGENT_CALL,
        },
      ],
      running,
    );
    const started = listItemEvents(events, "item.started", "web_search")[0];
    const completed = listItemEvents(events, "item.completed", "web_search")[0];
    expect(started?.subagentId).toBe(SUBAGENT);
    expect(completed?.subagentId).toBe(SUBAGENT);
    expect(completed?.turnId).toBe(started?.turnId);
  });

  describe("a block with no item to draw", () => {
    it("drops redacted_thinking and compaction blocks, and opens no turn for them", () => {
      const running = buildTestState();
      const events = run(
        [
          buildBlocks([
            { type: "redacted_thinking", data: "abc" },
            { type: "compaction", content: "summary", encrypted_content: null },
          ]),
        ],
        running,
      );
      expect(events).toEqual([]);
      expect(running.turnId).toBeUndefined();
    });

    it("shows a container_upload and a fallback block as labelled unknown items", () => {
      const { running, reports } = buildReportingState();
      const events = run(
        [
          buildBlocks([
            { type: "container_upload", file_id: "file_01" },
            {
              type: "fallback",
              from: { model: "claude-a" },
              to: { model: "claude-b" },
              trigger: { type: "refusal" },
            },
          ]),
        ],
        running,
      );
      const labels = events.flatMap((event) =>
        event._tag === "item.started" && event.kind === "unknown"
          ? [Schema.decodeUnknownSync(UnknownItemDetail)(event.detail).label]
          : [],
      );
      expect(labels).toEqual(["claude: assistant/container_upload", "claude: assistant/fallback"]);
      expect(reports.map((report) => report.label)).toEqual(labels);
    });

    it("shows a block type the table does not have as a labelled item, between its siblings", () => {
      const { running, reports } = buildReportingState();
      const lines = run(
        [
          buildBlocks([
            { type: "text", text: "before" },
            { type: "hologram\u202e", payload: 1 },
            { type: "text", text: "after" },
          ]),
        ],
        running,
      ).map(formatEvent);
      expect(lines.filter((line) => line.startsWith("item.started"))).toHaveLength(3);
      expect(lines.filter((line) => line.startsWith("content.delta"))).toEqual([
        'content.delta assistant_text "before"',
        'content.delta assistant_text "after"',
      ]);
      expect(reports.map((report) => report.label)).toEqual([
        "claude: assistant/hologram\\u{202e}",
      ]);
    });

    it("shows a block that cannot be read as one unknown item, without hiding or repeating its siblings", () => {
      const { running, reports } = buildReportingState();
      const events = run(
        [
          buildBlocks([
            { type: "text", text: "before" },
            // A web search result whose content is neither a list nor an error.
            { type: "web_search_tool_result", tool_use_id: SERVER_TOOL, content: null },
            { type: "text", text: "after" },
          ]),
        ],
        running,
      );
      const lines = events.map(formatEvent);
      expect(lines.filter((line) => line.startsWith("turn.started"))).toHaveLength(1);
      expect(listItemEvents(events, "item.started", "assistant_message")).toHaveLength(2);
      expect(listItemEvents(events, "item.started", "unknown")).toHaveLength(1);
      expect(listItemEvents(events, "item.started", "web_search")).toEqual([]);
      expect(reports).toHaveLength(1);
      expect(reports[0]?.label).toBe("claude: assistant/web_search_tool_result");
      expect(reports[0]?.error).toBeInstanceOf(Error);
    });
  });

  it("fails the running call of a result block that cannot be read, instead of adding an unknown item", () => {
    const { running, reports } = buildReportingState();
    const events = run(
      [
        buildBlocks([buildServerToolUse("web_search", { query: "q" })]),
        buildBlocks([{ type: "web_search_tool_result", tool_use_id: SERVER_TOOL, content: null }]),
      ],
      running,
    );
    expect(listItemEvents(events, "item.started", "unknown")).toEqual([]);
    expect(readCompleted(events, SERVER_TOOL)).toEqual({
      status: "failed",
      detail: {
        content: "The result could not be read (claude: assistant/web_search_tool_result)",
      },
    });
    expect(reports.map((report) => report.label)).toEqual([
      "claude: assistant/web_search_tool_result",
    ]);
    expect(running.tools.has(SERVER_TOOL)).toBe(false);
  });

  describe("a message whose text and thinking already streamed", () => {
    const streamedStart = (block: unknown) => [
      MESSAGE_START,
      buildStreamEvent({ type: "content_block_start", index: 0, content_block: block }),
    ];

    it("is not reported twice, but its other blocks are", () => {
      const running = buildTestState();
      const lines = run(
        [
          MESSAGE_START,
          TEXT_START,
          TEXT_DELTA,
          TEXT_STOP,
          buildBlocks([
            { type: "text", text: "ready" },
            buildServerToolUse("web_search", { query: "q" }),
          ]),
        ],
        running,
      ).map(formatEvent);
      expect(
        lines.filter((line) => line.startsWith("item.started assistant_message")),
      ).toHaveLength(1);
      expect(lines).toContain(`item.started web_search ${SERVER_TOOL}`);
    });

    it("shows a streamed server tool call exactly once, from the assistant message", () => {
      const lines = run([
        ...streamedStart({
          type: "server_tool_use",
          id: SERVER_TOOL,
          name: "web_search",
          input: {},
        }),
        buildStreamEvent({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"query": "q' },
        }),
        buildStreamEvent({ type: "content_block_stop", index: 0 }),
        buildBlocks([buildServerToolUse("web_search", { query: "q" })]),
        buildBlocks([
          { type: "web_search_tool_result", tool_use_id: SERVER_TOOL, content: SEARCH_HITS },
        ]),
      ]).map(formatEvent);
      expect(lines.filter((line) => line.includes("web_search"))).toEqual([
        `item.started web_search ${SERVER_TOOL}`,
        `item.completed web_search ${SERVER_TOOL} completed`,
      ]);
    });
  });

  describe("a local WebFetch or WebSearch tool", () => {
    const buildLocalWeb = (name: string, input: unknown) => ({
      ...ASSISTANT_TOOL_USE,
      message: {
        ...ASSISTANT_TOOL_USE.message,
        content: [{ type: "tool_use", id: TOOL, name, input }],
      },
    });

    it("shows WebFetch as a web_search item with the url", () => {
      const events = run([buildLocalWeb("WebFetch", { url: "https://example.com", prompt: "p" })]);
      expect(listItemEvents(events, "item.started", "web_search")[0]?.detail).toEqual({
        name: "WebFetch",
        input: { url: "https://example.com", prompt: "p" },
        url: "https://example.com",
      });
    });

    it("shows WebSearch as a web_search item with the query", () => {
      const events = run([buildLocalWeb("WebSearch", { query: "effect" })]);
      expect(listItemEvents(events, "item.started", "web_search")[0]?.detail).toEqual({
        name: "WebSearch",
        input: { query: "effect" },
        query: "effect",
      });
    });
  });

  it("turns a recorded run with a server web search into one search item with its results", () => {
    const frames = readFileSync(
      new URL("./claude-code-server-tools.fixture.jsonl", import.meta.url),
      "utf8",
    )
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => (JSON.parse(line) as { readonly frame: unknown }).frame);
    const events = run(frames);

    const started = listItemEvents(events, "item.started", "web_search");
    expect(started).toHaveLength(1);
    expect((started[0]?.detail as Record<string, unknown>)["query"]).toBe(
      "effect schema discriminated union",
    );
    const completed = readCompleted(events, "srvtoolu_01ServerSearch0001");
    expect(completed?.status).toBe("completed");
    expect(completed?.detail["content"]).toBe(
      [
        "Schema - Effect Documentation",
        "https://effect.website/docs/schema/introduction/",
        "",
        "Union | Effect Schema",
        "https://effect.website/docs/schema/basic-usage/#unions",
      ].join("\n"),
    );
    expect(
      events.map((event) => event._tag).filter((tag) => tag === "turn.completed"),
    ).toHaveLength(1);
    for (const event of events) expect(() => encode(event)).not.toThrow();
  });
});

describe("the todo list", () => {
  type Status = "pending" | "in_progress" | "completed";
  /** Builds an assistant message with one tool call. `agentCallId` puts it inside a subagent. */
  const buildCall = (
    id: string,
    name: string,
    input: unknown,
    agentCallId: string | null = null,
    messageId = `msg_${id}`,
  ) => ({
    type: "assistant",
    uuid: "4c6485ca-097a-43f5-8709-6865c49705ca",
    session_id: NATIVE,
    parent_tool_use_id: agentCallId,
    message: {
      id: messageId,
      role: "assistant",
      model: "claude-sonnet-5-5",
      content: [{ type: "tool_use", id, name, input }],
    },
  });

  /** Builds the user message that answers one call, with Claude's structured result. */
  const buildAnswer = (
    id: string,
    structured: unknown,
    {
      isError = false,
      agentCallId = null,
      content = "ok",
    }: { isError?: boolean; agentCallId?: string | null; content?: unknown } = {},
  ) => ({
    type: "user",
    uuid: "b7aa7458-44c1-4aed-8e9e-bc1f301e8246",
    session_id: NATIVE,
    parent_tool_use_id: agentCallId,
    message: {
      role: "user",
      content: [{ tool_use_id: id, type: "tool_result", content, is_error: isError }],
    },
    tool_use_result: structured,
  });

  const todo = (content: string, status: Status = "pending") => ({
    content,
    status,
    activeForm: `${content}...`,
  });

  /** A TodoWrite call and its answer. */
  const writeTodos = (id: string, todos: ReadonlyArray<ReturnType<typeof todo>>) => [
    buildCall(id, "TodoWrite", { todos }),
    buildAnswer(id, { oldTodos: [], newTodos: todos }),
  ];

  const lastId = (n: number) => `toolu_01TodoCall${String(n).padStart(10, "0")}`;

  /** Lists the todo events as `tag a=pending,b=done` lines, with the item id and the subagent. */
  const listTodoEvents = (events: ReadonlyArray<Event>) =>
    events.flatMap((event) => {
      if (
        (event._tag !== "item.started" &&
          event._tag !== "item.updated" &&
          event._tag !== "item.completed") ||
        event.kind !== "todo_list"
      ) {
        return [];
      }
      const { steps } = event.detail as {
        readonly steps: ReadonlyArray<{ text: string; status: Status }>;
      };
      return [
        `${event._tag} ${event.itemId} ${steps.map((step) => `${step.text}=${step.status}`).join(",")}`,
      ];
    });

  /**
   * Builds a state whose turn the user's input already opened. A turn that a
   * model message opens by itself is dropped when the message shows nothing,
   * and a todo call shows nothing.
   */
  const buildStateInTurn = (resumed = false) => {
    const running = buildTestState(undefined, undefined, () => {}, resumed);
    openTurn(running);
    return running;
  };

  const run = (
    messages: ReadonlyArray<unknown>,
    running = buildStateInTurn(),
  ): ReadonlyArray<Event> =>
    messages.flatMap((message) => normalize(running, message as SDKMessage));

  /** Returns the first tool_call item event with the given tag. */
  const findToolRow = (events: ReadonlyArray<Event>, tag: "item.started" | "item.completed") => {
    for (const event of events) {
      if (event._tag === tag && event.kind === "tool_call") return event;
    }
    return undefined;
  };

  const todoEventTags = (events: ReadonlyArray<Event>) =>
    listTodoEvents(events).map((line) => line.split(" ")[0]);

  it("shows TodoWrite called three times in a turn as one item that updates in place", () => {
    const first = [todo("a", "in_progress"), todo("b")];
    const second = [todo("a", "completed"), todo("b", "in_progress")];
    const third = [todo("a", "completed"), todo("b", "completed")];
    const events = run([
      ...writeTodos(lastId(1), first),
      ...writeTodos(lastId(2), second),
      ...writeTodos(lastId(3), third),
      RESULT,
    ]);
    const lines = listTodoEvents(events);
    const id = lines[0]?.split(" ")[1];
    expect(lines).toEqual([
      `item.started ${id} a=in_progress,b=pending`,
      `item.updated ${id} a=completed,b=in_progress`,
      `item.updated ${id} a=completed,b=completed`,
      `item.completed ${id} a=completed,b=completed`,
    ]);
    // The tool calls draw no rows of their own, and the item ends before its turn.
    expect(
      events.some((event) => event._tag === "item.started" && event.kind === "tool_call"),
    ).toBe(false);
    const tags = events.map((event) => `${event._tag}`);
    expect(tags.lastIndexOf("item.completed")).toBeLessThan(tags.indexOf("turn.completed"));
  });

  it("encodes every todo event with the protocol schema", () => {
    const encode = Schema.encodeUnknownSync(ProviderEvent);
    const events = run([
      ...writeTodos(lastId(1), [todo("a")]),
      ...writeTodos(lastId(2), [todo("b")]),
      RESULT,
    ]);
    for (const event of events) expect(() => encode(event)).not.toThrow();
  });

  it("opens a new item with the whole list when the next turn changes it", () => {
    const running = buildStateInTurn();
    const events = [
      ...run([...writeTodos(lastId(1), [todo("a"), todo("b")]), RESULT], running),
      ...openTurn(running).events,
      ...run(writeTodos(lastId(2), [todo("a", "completed"), todo("b")]), running),
    ];
    const lines = listTodoEvents(events);
    expect(lines.map((line) => line.split(" ")[0])).toEqual([
      "item.started",
      "item.completed",
      "item.started",
    ]);
    expect(lines[0]?.split(" ")[1]).not.toBe(lines[2]?.split(" ")[1]);
    expect(lines[2]?.split(" ")[2]).toBe("a=completed,b=pending");
  });

  it("shows nothing for a TodoWrite that leaves the list as it is", () => {
    const events = run([
      ...writeTodos(lastId(1), [todo("a")]),
      ...writeTodos(lastId(2), [todo("a")]),
    ]);
    expect(todoEventTags(events)).toEqual(["item.started"]);
  });

  it("shows a TodoWrite that failed as a failed tool row, with Claude's error text", () => {
    const events = run([
      buildCall(lastId(1), "TodoWrite", { todos: [todo("a")] }),
      buildAnswer(lastId(1), undefined, { isError: true, content: "todos must be a list" }),
    ]);
    const lines = events.map(formatEvent);
    expect(lines).toContain(`item.started tool_call ${lastId(1)}`);
    expect(lines).toContain(`item.completed tool_call ${lastId(1)} failed`);
    const started = findToolRow(events, "item.started");
    expect(started?.detail).toEqual({
      name: "TodoWrite",
      input: { todos: [todo("a")] },
      kind: "native",
    });
    const completed = findToolRow(events, "item.completed");
    expect(completed?.detail).toEqual({ content: "todos must be a list" });
    expect(listTodoEvents(events)).toEqual([]);
  });

  it("names the tool as the reason when a failed call has no error text", () => {
    const events = run([
      buildCall(lastId(1), "TodoWrite", { todos: [todo("a")] }),
      buildAnswer(lastId(1), undefined, { isError: true, content: "" }),
    ]);
    expect(findToolRow(events, "item.completed")?.detail).toEqual({ content: "TodoWrite failed" });
  });

  it("cuts the error text of a TaskUpdate to the length of a message", () => {
    const events = run([
      buildCall(lastId(1), "TaskUpdate", { taskId: "9", status: "completed" }),
      buildAnswer(lastId(1), { success: false, error: "e".repeat(MAX_MESSAGE_LENGTH + 500) }),
    ]);
    const content = (findToolRow(events, "item.completed")?.detail as { content: string }).content;
    expect(content).toHaveLength(MAX_MESSAGE_LENGTH);
    expect(content.endsWith("…")).toBe(true);
  });

  it("reports a failed call that answers after its turn ended to the log, and emits nothing", () => {
    const { running, reports } = buildReportingState();
    openTurn(running);
    const events = run(
      [
        buildCall(lastId(1), "TodoWrite", { todos: [todo("a")] }),
        RESULT,
        buildAnswer(lastId(1), undefined, { isError: true, content: "interrupted by the user" }),
      ],
      running,
    );
    expect(events.filter((event) => event._tag.startsWith("item."))).toEqual([]);
    expect(events.filter((event) => event._tag === "turn.started")).toEqual([]);
    expect(reports.map((report) => report.label)).toEqual([
      "claude: user/tool_result of a failed TodoWrite after its turn ended",
    ]);
    expect(String(reports[0]?.error)).toContain("interrupted by the user");
  });

  it("keeps a later turn's final list when an earlier turn's call answers late", () => {
    const old = [todo("old")];
    const fresh = [todo("fresh", "in_progress")];
    const running = buildStateInTurn();
    const events = [
      ...run(
        [
          buildCall(lastId(1), "TodoWrite", { todos: old }),
          { ...RESULT, terminal_reason: "aborted_streaming" },
        ],
        running,
      ),
      ...openTurn(running).events,
      ...run(writeTodos(lastId(2), fresh), running),
      // The first turn's call answers while the second turn is open.
      ...run([buildAnswer(lastId(1), { oldTodos: [], newTodos: old }), RESULT], running),
    ];
    const lines = listTodoEvents(events);
    expect(lines.map((line) => line.split(" ")[0])).toEqual(["item.started", "item.completed"]);
    expect(lines.map((line) => line.split(" ")[2])).toEqual([
      "fresh=in_progress",
      "fresh=in_progress",
    ]);
  });

  it("builds the list from TaskCreate, TaskUpdate and TaskList results", () => {
    const events = run([
      buildCall(lastId(1), "TaskCreate", { subject: "a", description: "d" }),
      buildAnswer(lastId(1), { task: { id: "1", subject: "a" } }),
      buildCall(lastId(2), "TaskCreate", { subject: "b", description: "d" }),
      buildAnswer(lastId(2), { task: { id: "2", subject: "b" } }),
      buildCall(lastId(3), "TaskUpdate", { taskId: "1", status: "completed" }),
      buildAnswer(lastId(3), { success: true, taskId: "1", updatedFields: ["status"] }),
      buildCall(lastId(4), "TaskList", {}),
      buildAnswer(lastId(4), {
        tasks: [
          { id: "1", subject: "a", status: "completed", blockedBy: [] },
          { id: "2", subject: "b", status: "pending", blockedBy: [] },
        ],
      }),
    ]);
    const lines = listTodoEvents(events);
    const id = lines[0]?.split(" ")[1];
    // TaskList returns what the list already is, so it adds no event.
    expect(lines).toEqual([
      `item.started ${id} a=pending`,
      `item.updated ${id} a=pending,b=pending`,
      `item.updated ${id} a=completed,b=pending`,
    ]);
  });

  it("uses the structured result only when the message holds one tool result", () => {
    const answer = {
      ...buildAnswer(lastId(1), { oldTodos: [], newTodos: [todo("from the result")] }),
      message: {
        role: "user",
        content: [
          { tool_use_id: lastId(1), type: "tool_result", content: "ok" },
          { tool_use_id: lastId(2), type: "tool_result", content: "ok" },
        ],
      },
    };
    const events = run([
      buildCall(lastId(1), "TodoWrite", { todos: [todo("from the input")] }),
      answer,
    ]);
    expect(listTodoEvents(events)[0]).toContain("from the input=pending");
  });

  describe("in a resumed session", () => {
    it("shows nothing for TaskCreate until TaskList hands over the whole list", () => {
      const running = buildStateInTurn(true);
      const created = run(
        [
          buildCall(lastId(1), "TaskCreate", { subject: "c", description: "d" }),
          buildAnswer(lastId(1), { task: { id: "3", subject: "c" } }),
        ],
        running,
      );
      expect(listTodoEvents(created)).toEqual([]);
      expect(
        created.some((event) => event._tag === "item.started" && event.kind === "tool_call"),
      ).toBe(false);
      const listed = run(
        [
          buildCall(lastId(2), "TaskList", {}),
          buildAnswer(lastId(2), {
            tasks: [
              { id: "1", subject: "a", status: "completed", blockedBy: [] },
              { id: "3", subject: "c", status: "pending", blockedBy: [] },
            ],
          }),
        ],
        running,
      );
      expect(listTodoEvents(listed).map((line) => line.split(" ")[0])).toEqual(["item.started"]);
      expect(listTodoEvents(listed)[0]).toContain("a=completed,c=pending");
    });
  });

  it("shows nothing for a seeded subagent's TaskCreate until its TaskList", () => {
    const running = buildTestState(undefined, [{ subagentId: SUBAGENT, itemId: AGENT_CALL }]);
    openTurn(running);
    const inSubagent = { agentCallId: AGENT_CALL };
    const created = run(
      [
        buildTaskStarted(SUBAGENT, AGENT_CALL),
        buildCall(lastId(1), "TaskCreate", { subject: "c", description: "d" }, AGENT_CALL),
        buildAnswer(lastId(1), { task: { id: "3", subject: "c" } }, inSubagent),
      ],
      running,
    );
    expect(listTodoEvents(created)).toEqual([]);
    const listed = run(
      [
        buildCall(lastId(2), "TaskList", {}, AGENT_CALL),
        buildAnswer(
          lastId(2),
          { tasks: [{ id: "3", subject: "c", status: "pending", blockedBy: [] }] },
          inSubagent,
        ),
      ],
      running,
    );
    expect(listTodoEvents(listed).map((line) => line.split(" ")[0])).toEqual(["item.started"]);
    // The session's own agent was not resumed, so its list is known and empty.
    const own = run(
      [
        buildCall(lastId(3), "TaskCreate", { subject: "own", description: "d" }),
        buildAnswer(lastId(3), { task: { id: "1", subject: "own" } }),
      ],
      running,
    );
    expect(listTodoEvents(own)[0]).toContain("own=pending");
  });

  it("keeps a turn that a model message opened with only a todo call, and shows the list in it", () => {
    // No input opened the turn, as after a background task finished.
    const running = buildTestState();
    const events = run(
      [
        buildCall(lastId(1), "TodoWrite", { todos: [todo("a")] }),
        buildAnswer(lastId(1), { oldTodos: [], newTodos: [todo("a")] }),
      ],
      running,
    );
    const turns = events.filter((event) => event._tag === "turn.started");
    expect(turns).toHaveLength(1);
    const started = events.find(
      (event) => event._tag === "item.started" && event.kind === "todo_list",
    );
    expect(started?._tag === "item.started" ? started.turnId : undefined).toBe(running.turnId);
    expect(listTodoEvents(events)).toHaveLength(1);
  });

  it("shows nothing for a result that arrives after its turn ended, and opens no turn", () => {
    const running = buildStateInTurn();
    const events = run(
      [
        buildCall(lastId(1), "TodoWrite", { todos: [todo("a")] }),
        RESULT,
        buildAnswer(lastId(1), { oldTodos: [], newTodos: [todo("a")] }),
      ],
      running,
    );
    expect(listTodoEvents(events)).toEqual([]);
    expect(events.filter((event) => event._tag === "turn.started")).toHaveLength(0);
    expect(running.turnId).toBeUndefined();
  });

  it("keeps a subagent's list apart from its parent's", () => {
    const running = buildStateInTurn();
    const events = run(
      [
        buildCall(AGENT_CALL, "Agent", { description: "d", prompt: "p", subagent_type: "x" }),
        buildTaskStarted(SUBAGENT, AGENT_CALL),
        buildCall(lastId(1), "TodoWrite", { todos: [todo("sub")] }, AGENT_CALL),
        buildAnswer(
          lastId(1),
          { oldTodos: [], newTodos: [todo("sub")] },
          { agentCallId: AGENT_CALL },
        ),
        // The same list from the parent is a change for the parent.
        ...writeTodos(lastId(2), [todo("sub")]),
        buildTaskNotification(SUBAGENT, AGENT_CALL),
        RESULT,
      ],
      running,
    );
    const todoEvents = events.filter(
      (event) =>
        (event._tag === "item.started" || event._tag === "item.completed") &&
        event.kind === "todo_list",
    );
    expect(
      todoEvents.map((event) => `${event._tag} ${"subagentId" in event ? event.subagentId : ""}`),
    ).toEqual([
      `item.started ${SUBAGENT}`,
      "item.started ",
      `item.completed ${SUBAGENT}`,
      "item.completed ",
    ]);
  });

  it("completes the item before an interrupted turn ends", () => {
    const events = run([
      ...writeTodos(lastId(1), [todo("a", "in_progress")]),
      { ...RESULT, terminal_reason: "aborted_streaming" },
    ]);
    const tags = events.map((event) => event._tag);
    const done = events.findIndex(
      (event) => event._tag === "item.completed" && event.kind === "todo_list",
    );
    expect(done).toBeGreaterThan(-1);
    expect(done).toBeLessThan(tags.indexOf("turn.completed"));
  });

  it("leaves other agents' items open when one agent's turn ends", () => {
    const running = buildStateInTurn();
    run(
      [
        buildCall(AGENT_CALL, "Agent", { description: "d", prompt: "p", subagent_type: "x" }),
        buildTaskStarted(SUBAGENT, AGENT_CALL),
        buildCall(lastId(1), "TodoWrite", { todos: [todo("sub")] }, AGENT_CALL),
        buildAnswer(
          lastId(1),
          { oldTodos: [], newTodos: [todo("sub")] },
          { agentCallId: AGENT_CALL },
        ),
      ],
      running,
    );
    const ended = run([RESULT], running);
    expect(listTodoEvents(ended)).toEqual([]);
    expect(running.todos.get(SUBAGENT)?.open).toBeDefined();
  });
});
