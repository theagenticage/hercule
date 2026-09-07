/**
 * The SDK message shapes below were captured from the real CLI at 2.1.263
 * running one turn that thought, ran `echo hi` through `Bash`, and answered.
 * They are trimmed of long signatures and unread fields, never reshaped.
 */
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ProviderEvent } from "@hydra/protocol";
import { CLAUDE_SDK_MESSAGE, normalize, normalizing } from "./claude-code-normalize";

const SESSION = "0199e0e7-0000-7000-8000-0000000000ff";
const NATIVE = "a2c71f4c-13ba-41ba-b372-49675028b0b1";
const MESSAGE = "msg_011CeoxAoRk4jaxYB956uTmL";
const TOOL = "toolu_016JZjZUP3FNEkwxFk3eJZao";

/** Ids the test can read: the tenth minted id is `id-10`, in mint order. */
const state = () => {
  let minted = 0;
  return normalizing(
    SESSION,
    () => `id-${(minted += 1)}`,
    () => "2026-09-07T10:51:47.000Z",
  );
};

/** What each event says, short enough to read a whole turn as a list. */
type Event = Schema.Schema.Type<typeof ProviderEvent>;

const said = (event: Event): string => {
  switch (event._tag) {
    case "item.started":
    case "item.updated":
      return `${event._tag} ${event.kind} ${event.itemId}`;
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

const through = (messages: ReadonlyArray<unknown>): ReadonlyArray<string> => {
  const running = state();
  return messages.flatMap((message) => normalize(running, message as SDKMessage).map(said));
};

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

/** The leg after a tool result is a new model call, so a new message. */
const MESSAGE_START_AFTER_TOOL = {
  type: "stream_event",
  session_id: NATIVE,
  parent_tool_use_id: null,
  event: {
    type: "message_start",
    message: { id: MESSAGE_AFTER_TOOL, model: "claude-haiku-4-5-20251001", role: "assistant" },
  },
};

const streamed = (event: unknown) => ({
  type: "stream_event",
  session_id: NATIVE,
  parent_tool_use_id: null,
  event,
});

const THINKING_START = streamed({
  type: "content_block_start",
  index: 0,
  content_block: { type: "thinking", thinking: "", signature: "" },
});

const THINKING_DELTA = streamed({
  type: "content_block_delta",
  index: 0,
  delta: { type: "thinking_delta", thinking: "The user wants an echo." },
});

const SIGNATURE_DELTA = streamed({
  type: "content_block_delta",
  index: 0,
  delta: { type: "signature_delta", signature: "EoMDCrIBCBEYAipAdq0YOrgkNZI" },
});

const THINKING_STOP = streamed({ type: "content_block_stop", index: 0 });

const TOOL_START = streamed({
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

const TOOL_ARGUMENT_DELTA = streamed({
  type: "content_block_delta",
  index: 1,
  delta: { type: "input_json_delta", partial_json: '{"command": "echo hi' },
});

const TEXT_START = streamed({
  type: "content_block_start",
  index: 1,
  content_block: { type: "text", text: "" },
});

const TEXT_DELTA = streamed({
  type: "content_block_delta",
  index: 1,
  delta: { type: "text_delta", text: "ready" },
});

const TEXT_STOP = streamed({ type: "content_block_stop", index: 1 });

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
  // Two entries: the auxiliary call that titled the session, and the main loop.
  // `usage` above counts only the main loop, and only this turn.
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

describe("one SDK message at a time", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly messages: ReadonlyArray<unknown>;
    readonly events: ReadonlyArray<string>;
  }> = [
    {
      // The adapter reads the native id off it and emits `session.started`
      // itself, so the taxonomy has nothing to say here.
      name: "the init message says nothing normalized",
      messages: [INIT],
      events: [],
    },
    {
      name: "a text block streams as one assistant_message item",
      messages: [MESSAGE_START, TEXT_START, TEXT_DELTA, TEXT_STOP],
      events: [
        "turn.started",
        `item.started assistant_message ${MESSAGE}#1`,
        'content.delta assistant_text "ready"',
        `item.completed assistant_message ${MESSAGE}#1 completed`,
      ],
    },
    {
      name: "a thinking block streams as reasoning, and its signature is not text",
      messages: [MESSAGE_START, THINKING_START, THINKING_DELTA, SIGNATURE_DELTA, THINKING_STOP],
      events: [
        "turn.started",
        `item.started reasoning ${MESSAGE}#0`,
        'content.delta reasoning_text "The user wants an echo."',
        `item.completed reasoning ${MESSAGE}#0 completed`,
      ],
    },
    {
      // There is no argument-streaming kind: the call lands whole on the
      // assistant message that follows (spec 06 section 6.3).
      name: "a tool block's partial arguments are not a stream",
      messages: [MESSAGE_START, TOOL_START, TOOL_ARGUMENT_DELTA],
      events: [],
    },
    {
      name: "a Bash call is a command_execution item under its native tool id",
      messages: [ASSISTANT_TOOL_USE],
      events: ["turn.started", `item.started command_execution ${TOOL}`],
    },
    {
      name: "a tool result completes the item the call opened, with its kind",
      messages: [ASSISTANT_TOOL_USE, TOOL_RESULT],
      events: [
        "turn.started",
        `item.started command_execution ${TOOL}`,
        `item.completed command_execution ${TOOL} completed`,
      ],
    },
    {
      name: "a complete assistant message that never streamed still becomes an item",
      messages: [ASSISTANT_THINKING],
      events: [
        "turn.started",
        "item.started reasoning id-3",
        'content.delta reasoning_text "The user wants an echo."',
        "item.completed reasoning id-3 completed",
      ],
    },
    {
      // The CLI sends one complete assistant message per finished block, so a
      // block's index inside its message is not its index in the stream. The
      // echo is recognised by its message id, never by position.
      name: "a streamed block is not restated by the message that echoes it",
      messages: [MESSAGE_START, THINKING_START, THINKING_DELTA, THINKING_STOP, ASSISTANT_THINKING],
      events: [
        "turn.started",
        `item.started reasoning ${MESSAGE}#0`,
        'content.delta reasoning_text "The user wants an echo."',
        `item.completed reasoning ${MESSAGE}#0 completed`,
      ],
    },
    {
      // The block that streamed at index 1 is the only block of its own
      // complete message, so an index-matched echo check would emit it twice.
      name: "a text block that streamed second is not restated either",
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
      name: "the result closes the turn and reports cumulative usage",
      messages: [RESULT],
      events: ["turn.started", "session.usage.updated", "turn.completed completed"],
    },
    {
      // Rate limits are snapshot material and progress chatter is nothing;
      // both are trimmed on purpose (spec 06 section 6.7).
      name: "the informational tail is trimmed, not turned into items",
      messages: [RATE_LIMIT, STATUS],
      events: [],
    },
    {
      // The tail arrives after the `result` that closed the last turn, so a
      // turn opened for it has to be closed by it too.
      name: "a message shape this build has not heard of becomes an unknown item in its own turn",
      messages: [{ type: "system", subtype: "image_generated", session_id: NATIVE }],
      events: [
        "turn.started",
        "item.started unknown id-3",
        "item.completed unknown id-3 completed",
        "turn.completed completed",
      ],
    },
    {
      name: "a retry is a runtime warning, not an item",
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
      name: "a compaction is an item of its own kind",
      messages: [
        {
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: { trigger: "auto", pre_tokens: 150000, post_tokens: 40000 },
          session_id: NATIVE,
        },
      ],
      // Compaction can happen between turns, so the turn it opens is its own
      // to close: no `result` is coming for it.
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
      expect(through(one.messages)).toEqual(one.events);
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

describe("a whole turn", () => {
  it("reads as the episode it was", () => {
    expect(through(TURN)).toEqual([
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

  it("carries the vendor payload on the first event of each message, and never on a delta", () => {
    const running = state();
    const raw = TURN.flatMap((message) => normalize(running, message as SDKMessage)).filter(
      (event) => event.raw !== undefined,
    );
    expect(raw.length).toBeGreaterThan(0);
    for (const event of raw) {
      expect(event.raw?.source).toBe(CLAUDE_SDK_MESSAGE);
      expect(event._tag).not.toBe("content.delta");
    }
  });

  it("takes the usage snapshot the result reports", () => {
    const running = state();
    const events = normalize(running, RESULT as unknown as SDKMessage);
    const snapshot = events.find((event) => event._tag === "session.usage.updated");
    // Every model call the session made, summed, not the main loop's own turn.
    expect(snapshot?._tag === "session.usage.updated" ? snapshot.usage : undefined).toEqual({
      inputTokens: 929,
      outputTokens: 165,
      cacheReadTokens: 14523,
      cacheWriteTokens: 14688,
      costUsd: 0.0325823,
    });
  });

  it("opens the next turn after the result closed the last one", () => {
    const running = state();
    normalize(running, RESULT as unknown as SDKMessage);
    expect(running.turnId).toBeUndefined();
    const next = normalize(running, ASSISTANT_TOOL_USE as unknown as SDKMessage);
    expect(next[0]?._tag).toBe("turn.started");
  });
});

describe("a turn that did not simply finish", () => {
  it("reports an abort as interrupted", () => {
    const events = through([{ ...RESULT, terminal_reason: "aborted_streaming" }]);
    expect(events).toContain("turn.completed interrupted");
  });

  it("reports an error result as failed, with what the harness said", () => {
    const running = state();
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

describe("what an item says about itself", () => {
  const detailOf = (
    messages: ReadonlyArray<unknown>,
    itemId: string,
    tag: "item.started" | "item.completed",
  ): unknown => {
    const running = state();
    const events = messages.flatMap((message) => normalize(running, message as SDKMessage));
    for (const event of events) {
      if (event._tag === tag && event.itemId === itemId) return event.detail;
    }
    return undefined;
  };

  it("names the tool and carries the arguments it was called with", () => {
    expect(detailOf([ASSISTANT_TOOL_USE], TOOL, "item.started")).toEqual({
      name: "Bash",
      input: { command: "echo hi", description: "Echo hi" },
    });
  });

  it("tells an MCP tool apart from a native one by its name", () => {
    const call = (name: string) => ({
      ...ASSISTANT_TOOL_USE,
      message: {
        ...ASSISTANT_TOOL_USE.message,
        content: [{ type: "tool_use", id: TOOL, name, input: {} }],
      },
    });
    expect(detailOf([call("mcp__linear__issues")], TOOL, "item.started")).toEqual({
      name: "mcp__linear__issues",
      input: {},
      kind: "mcp",
    });
    expect(detailOf([call("Glob")], TOOL, "item.started")).toEqual({
      name: "Glob",
      input: {},
      kind: "native",
    });
  });

  it("carries the tool's output on the item the result completes", () => {
    expect(detailOf([ASSISTANT_TOOL_USE, TOOL_RESULT], TOOL, "item.completed")).toEqual({
      content: "hi",
    });
  });

  it("carries the user's own text, and drops what the harness synthesised", () => {
    const running = state();
    const sent = {
      type: "user",
      session_id: NATIVE,
      parent_tool_use_id: null,
      message: { role: "user", content: "run the tests" },
    };
    const events = normalize(running, sent as unknown as SDKMessage);
    const opened = events.find((event) => event._tag === "item.started");
    expect(opened?._tag === "item.started" ? opened.detail : undefined).toEqual({
      text: "run the tests",
    });
    // A message the taxonomy has nothing to say about does not leave a turn
    // behind it either.
    expect(through([{ ...sent, isSynthetic: true }])).toEqual([]);
  });

  it("puts the vendor payload on the unknown item, not on the turn it had to open", () => {
    const running = state();
    const events = normalize(running, {
      type: "system",
      subtype: "image_generated",
      session_id: NATIVE,
    } as unknown as SDKMessage);
    expect(events.find((event) => event.raw !== undefined)?._tag).toBe("item.started");
  });
});

describe("what the ops events say", () => {
  it("says which retry it is and what the harness was retrying after", () => {
    const running = state();
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

  it("says what a compaction did to the context", () => {
    const running = state();
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

describe("what a turn reports when it was interrupted", () => {
  it("says nothing about an error: the text it stopped on is the assistant's, not a reason", () => {
    const running = state();
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

describe("what the protocol will carry", () => {
  const encode = Schema.encodeUnknownSync(ProviderEvent);

  it("encodes every event a whole turn produces", () => {
    const running = state();
    for (const message of TURN) {
      for (const event of normalize(running, message as SDKMessage)) {
        expect(() => encode(event)).not.toThrow();
      }
    }
  });

  it("encodes a tool result that came back with no output at all", () => {
    const running = state();
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

describe("what nothing can take the session down with", () => {
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
      const running = state();
      expect(() => normalize(running, message as SDKMessage)).not.toThrow();
      const kinds = through([message]).map((event) => event.split(" ").slice(0, 2).join(" "));
      expect(kinds).toContain("item.started unknown");
    });
  }
});

describe("two agents streaming at once", () => {
  const from = (parent: string | null, event: unknown) => ({
    type: "stream_event",
    session_id: NATIVE,
    parent_tool_use_id: parent,
    event,
  });

  const opening = (id: string) => ({
    type: "message_start",
    message: { id, model: "claude-haiku-4-5-20251001", role: "assistant" },
  });

  const text = { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };

  it("keeps the main loop's blocks apart from a subagent's", () => {
    expect(
      through([
        from(null, opening("msg_main")),
        from(null, text),
        from("toolu_sub", opening("msg_sub")),
        from("toolu_sub", text),
        from(null, {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "from the main loop" },
        }),
        from(null, { type: "content_block_stop", index: 0 }),
      ]),
    ).toEqual([
      "turn.started",
      "item.started assistant_message msg_main#0",
      "item.started assistant_message msg_sub#0",
      'content.delta assistant_text "from the main loop"',
      "item.completed assistant_message msg_main#0 completed",
    ]);
  });
});
