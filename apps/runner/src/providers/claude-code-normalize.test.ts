/**
 * The SDK messages below were captured from the real CLI, version 2.1.263,
 * during one turn in which the model thought, ran `echo hi` with `Bash`, and
 * replied. Long signatures and unused fields were removed; nothing else was
 * changed.
 */
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  MAX_FRAME_BYTES,
  ProviderEvent,
  type ContinuedSubagent,
  type OutputSchema,
} from "@hercule/protocol";
import {
  CLAUDE_SDK_MESSAGE,
  normalize,
  buildNormalizingState,
  isAnyAgentWorking,
} from "./claude-code-normalize";
import { measureFrameBytes } from "../frame-size";
import { fitEventToFrame } from "../sessions/fit-event";
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
 * tenth is `id-10`.
 */
const buildTestState = (outputSchema?: OutputSchema, seeded?: ReadonlyArray<ContinuedSubagent>) => {
  let minted = 0;
  return buildNormalizingState(
    SESSION,
    () => `id-${(minted += 1)}`,
    () => "2026-09-07T10:51:47.000Z",
    // No schema means the session replies in free text, as most turns in this
    // file do. Tests that need structured output pass a schema.
    outputSchema,
    seeded,
  );
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
      // Rate limits belong in the capability snapshot, and status updates hold
      // nothing useful, so both are dropped on purpose (spec 06 section 6.7).
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
      name: "reports a compaction as a context_compaction item",
      messages: [
        {
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "auto", pre_tokens: 150000, post_tokens: 40000 },
          session_id: NATIVE,
        },
      ],
      // Compaction can happen between turns, so it closes the turn it opened:
      // no `result` will arrive for that turn.
      events: [
        "turn.started",
        "item.started context_compaction id-3",
        "item.completed context_compaction id-3 completed",
        "turn.completed completed",
      ],
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
    expect(readItemDetail([buildToolUse("Glob")], TOOL, "item.started")).toEqual({
      name: "Glob",
      input: {},
      kind: "native",
    });
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

describe("runtime warnings and compaction details", () => {
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

  it("reports the context size before and after a compaction", () => {
    const running = buildTestState();
    const events = normalize(running, {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 150000, post_tokens: 40000 },
      session_id: NATIVE,
    } as unknown as SDKMessage);
    const opened = events.find((event) => event._tag === "item.started");
    expect(opened?._tag === "item.started" ? opened.detail : undefined).toEqual({
      trigger: "auto",
      preTokens: 150000,
      postTokens: 40000,
    });
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
  // task_notification that closed the turn. A turn opened for it is closed at
  // once, or nothing would ever close it and the subagent would look running.
  // The subagent was stopped, so that turn ends as interrupted too.
  it("closes the turn a trailing tool result opened for a stopped subagent as interrupted", () => {
    const running = buildTestState();
    const lines = [
      buildTaskStarted(SUBAGENT, AGENT_CALL),
      buildSubagentToolUse(AGENT_CALL),
      buildTaskNotification(SUBAGENT, AGENT_CALL, "stopped"),
      buildSubagentToolResult(AGENT_CALL),
    ].flatMap((message) => normalize(running, message as unknown as SDKMessage).map(formatEvent));
    expect(lines.slice(-3)).toEqual([
      `turn.started @${SUBAGENT}`,
      `item.completed command_execution ${SUBAGENT_TOOL} completed @${SUBAGENT}`,
      `turn.completed interrupted @${SUBAGENT}`,
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

  it("attributes a permission denial to the subagent whose call was denied", () => {
    expect(
      normalizeMessages([
        buildTaskStarted(SUBAGENT, AGENT_CALL),
        buildSubagentToolUse(AGENT_CALL, "Write"),
        buildPermissionDenied(SUBAGENT),
      ]).slice(-2),
    ).toEqual([
      `item.started unknown id-8 @${SUBAGENT}`,
      `item.completed unknown id-8 completed @${SUBAGENT}`,
    ]);
  });

  it("attributes a permission denial with no agent id to the session's own agent", () => {
    expect(normalizeMessages([buildPermissionDenied(undefined)])).toEqual([
      "turn.started",
      "item.started unknown id-3",
      "item.completed unknown id-3 completed",
      "turn.completed completed",
    ]);
  });

  // Attributed to the session's own agent, the denial would open a turn of
  // that agent, which is not working.
  it("holds a permission denial from an unknown agent until task_started names it", () => {
    const running = buildTestState();
    expect(normalize(running, buildPermissionDenied(SUBAGENT) as unknown as SDKMessage)).toEqual(
      [],
    );
    const lines = normalize(
      running,
      buildTaskStarted(SUBAGENT, AGENT_CALL) as unknown as SDKMessage,
    ).map(formatEvent);
    expect(lines.filter((line) => line.startsWith("item.started"))).toEqual([
      `item.started user_message id-4 @${SUBAGENT}`,
      `item.started unknown id-7 @${SUBAGENT}`,
    ]);
    expect(lines.some((line) => !line.includes("@") && line.startsWith("turn."))).toBe(false);
  });

  it("keeps a permission denial from an unknown agent held past another subagent's task_started", () => {
    const running = buildTestState();
    const denied = buildPermissionDenied("a0unknown0000000");
    normalize(running, denied as unknown as SDKMessage);
    expect(
      normalize(running, buildTaskStarted(SUBAGENT, AGENT_CALL) as unknown as SDKMessage).map(
        formatEvent,
      ),
    ).toEqual([`subagent.started ${SUBAGENT} parent=main item=${AGENT_CALL}`]);
    expect(running.heldFrames).toEqual([denied]);
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

  it("is normalized to an item.completed larger than a frame, which fitting sends with a warning", () => {
    const running = buildTestState();
    normalize(running, ASSISTANT_TOOL_USE as unknown as SDKMessage);
    const events = normalize(running, IMAGE_RESULT as unknown as SDKMessage);
    const completed = events.find((event) => event._tag === "item.completed");

    // The image is in `detail` and again in `raw`, so the frame would close
    // the runner's socket.
    expect(completed).toBeDefined();
    expect(measureEventBytes(completed!)).toBeGreaterThan(MAX_FRAME_BYTES);

    const fitted = fitEventToFrame(completed!);
    expect(fitted.map(formatEvent)).toEqual([
      `item.completed command_execution ${TOOL} completed`,
      "runtime.warning",
    ]);
    for (const event of fitted)
      expect(measureEventBytes(event)).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    const warning = fitted[1];
    expect(warning?._tag === "runtime.warning" ? warning.message : "").toContain(`Item ${TOOL}.`);
  });
});
