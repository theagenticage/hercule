/**
 * The pi normalizer: one line off pi's stdout plus a per-session running state
 * in, normalized events out. Nothing here starts a process.
 *
 * The lines are pi 0.85.1's own RPC event shapes, from `docs/rpc.md` and the
 * types behind it - `AgentEvent` in `@earendil-works/pi-agent-core`,
 * `AgentSessionEvent` in `dist/core/agent-session.d.ts` and the stdout
 * projection in `dist/modes/json-event.d.ts`, which is what strips the
 * cumulative `partial` snapshot off every `assistantMessageEvent` and puts the
 * call id and the tool name on `toolcall_start`.
 *
 * Assumed surface, because the module is the implementer's to name: the two
 * exports mirror `codex/normalize.ts`, `normalizing(sessionId, nativeSessionId)`
 * builds the running state and `normalize(state, line)` takes one raw line off
 * stdout - raw, not decoded, because a line that is not JSON is one of the
 * cases below. Event ids and the `at` instant are the module's own business and
 * nothing here reads them. Rename either export and these tests follow.
 */
import { describe, expect, it } from "vitest";
import type { ProviderEvent } from "@hydra/protocol";
import { normalize, normalizing } from "./normalize";

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

const message = (content: ReadonlyArray<Record<string, unknown>>, totals = usage) => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "zai",
  model: "glm-5.3",
  usage: totals,
  stopReason: "stop",
  timestamp: 1789373122124,
});

const line = (event: Record<string, unknown>): string => JSON.stringify(event);

const state = () => normalizing(SESSION, NATIVE);

const through = (
  running: ReturnType<typeof normalizing>,
  events: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<ProviderEvent> => events.flatMap((event) => normalize(running, line(event)));

/** A whole sequence against a state of its own, which is the common case. */
const fresh = (events: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<ProviderEvent> =>
  through(state(), events);

const tags = (events: ReadonlyArray<ProviderEvent>): ReadonlyArray<string> =>
  events.map((event) => event._tag);

const only = <Tag extends ProviderEvent["_tag"]>(
  events: ReadonlyArray<ProviderEvent>,
  tag: Tag,
): ReadonlyArray<Extract<ProviderEvent, { _tag: Tag }>> =>
  events.filter((event): event is Extract<ProviderEvent, { _tag: Tag }> => event._tag === tag);

const delta = (assistantMessageEvent: Record<string, unknown>) => ({
  type: "message_update",
  usage,
  assistantMessageEvent,
});

const TEXT = [{ type: "text", text: "OK" }];

const ANSWERING = [
  { type: "agent_start" },
  { type: "turn_start" },
  { type: "message_start", message: message([], ZERO) },
  delta({ type: "text_start", contentIndex: 0 }),
  delta({ type: "text_delta", contentIndex: 0, delta: "O" }),
  delta({ type: "text_delta", contentIndex: 0, delta: "K" }),
  delta({ type: "text_end", contentIndex: 0, content: "OK" }),
  { type: "message_end", message: message(TEXT) },
  { type: "turn_end", message: message(TEXT), toolResults: [] },
  { type: "agent_end", messages: [message(TEXT)], willRetry: false },
  { type: "agent_settled" },
];

const toolStart = (toolName: string, args: Record<string, unknown>) => ({
  type: "tool_execution_start",
  toolCallId: CALL,
  toolName,
  args,
});

const partial = (text: string) => ({
  type: "tool_execution_update",
  toolCallId: CALL,
  toolName: "bash",
  args: { command: "echo hello" },
  partialResult: {
    content: [{ type: "text", text }],
    details: { truncation: null, fullOutputPath: null },
  },
});

const toolEnd = (isError: boolean) => ({
  type: "tool_execution_end",
  toolCallId: CALL,
  toolName: "bash",
  result: { content: [{ type: "text", text: "hello\n" }], details: {} },
  isError,
});

describe("what a whole pi turn normalizes to", () => {
  it("reports the turn, the assistant's item, its deltas, and both completions", () => {
    const events = fresh(ANSWERING);

    expect(tags(events)).toEqual([
      "turn.started",
      "item.started",
      "content.delta",
      "content.delta",
      "item.completed",
      "session.usage.updated",
      "turn.completed",
    ]);
    expect(only(events, "item.started")[0]?.kind).toBe("assistant_message");
    expect(only(events, "content.delta").map((event) => event.delta)).toEqual(["O", "K"]);
    expect(only(events, "content.delta")[0]?.streamKind).toBe("assistant_text");
    expect(only(events, "item.completed")[0]?.status).toBe("completed");
  });

  it("files everything in the turn it opened, so a consumer can bracket it", () => {
    const events = fresh(ANSWERING);

    const turnId = only(events, "turn.started")[0]?.turnId;
    expect(turnId).toBeDefined();
    for (const event of events) {
      if ("turnId" in event) expect(event.turnId).toBe(turnId);
    }
  });

  it("reports thinking as its own item on its own stream, before the answer", () => {
    const events = fresh([
      { type: "agent_start" },
      { type: "message_start", message: message([], ZERO) },
      delta({ type: "thinking_start", contentIndex: 0 }),
      delta({ type: "thinking_delta", contentIndex: 0, delta: "The user said hi." }),
      delta({ type: "thinking_end", contentIndex: 0, content: "The user said hi." }),
      delta({ type: "text_start", contentIndex: 1 }),
      delta({ type: "text_delta", contentIndex: 1, delta: "OK" }),
      delta({ type: "text_end", contentIndex: 1, content: "OK" }),
      { type: "message_end", message: message([{ type: "thinking", thinking: "..." }, ...TEXT]) },
    ]);

    expect(only(events, "item.started").map((event) => event.kind)).toEqual([
      "reasoning",
      "assistant_message",
    ]);
    const reasoning = only(events, "content.delta").filter(
      (event) => event.streamKind === "reasoning_text",
    );
    expect(reasoning.map((event) => event.delta)).toEqual(["The user said hi."]);
    // The two blocks are two items: a surface that folded them into one would
    // show the model's thinking as its answer.
    expect(new Set(only(events, "item.started").map((event) => event.itemId)).size).toBe(2);
  });

  it("reports the session's usage and the turn's own cost when the run settles", () => {
    const events = fresh(ANSWERING);

    expect(only(events, "session.usage.updated")[0]?.usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 8,
      cacheReadTokens: 30,
      cacheWriteTokens: 0,
    });
    const completed = only(events, "turn.completed")[0];
    expect(completed?.state).toBe("completed");
    expect(completed?.costUsd).toBe(usage.cost.total);
    expect(completed?.usage).toMatchObject({ inputTokens: 120, outputTokens: 8 });
  });

  it("warns about a run pi will retry by itself, and ends no turn on it", () => {
    const events = fresh([
      { type: "agent_start" },
      { type: "agent_end", messages: [], willRetry: true },
    ]);

    expect(only(events, "runtime.warning")).toHaveLength(1);
    expect(only(events, "runtime.warning")[0]?.message ?? "").not.toBe("");
    // The turn is not over: pi is about to run again under it.
    expect(only(events, "turn.completed")).toEqual([]);
  });
});

describe("what a tool call on a pi turn normalizes to", () => {
  it("reports a shell command as a command execution, streaming only what is new", () => {
    const events = fresh([
      { type: "agent_start" },
      toolStart("bash", { command: "echo hello" }),
      partial("hel"),
      partial("hello\n"),
      toolEnd(false),
    ]);

    expect(tags(events)).toEqual([
      "turn.started",
      "item.started",
      "content.delta",
      "content.delta",
      "item.completed",
    ]);
    expect(only(events, "item.started")[0]?.kind).toBe("command_execution");
    // pi's `partialResult` is the whole output so far, so the delta is the
    // suffix: appending the cumulative text would print the output twice.
    expect(only(events, "content.delta").map((event) => event.delta)).toEqual(["hel", "lo\n"]);
    expect(only(events, "content.delta")[0]?.streamKind).toBe("command_output");
    expect(only(events, "item.completed")[0]?.status).toBe("completed");
  });

  it("reports a failed tool call as a failed item", () => {
    const events = fresh([
      { type: "agent_start" },
      toolStart("bash", { command: "nope" }),
      toolEnd(true),
    ]);

    expect(only(events, "item.completed")[0]?.status).toBe("failed");
  });

  it("reports an edit as a file change and anything else as a tool call", () => {
    const edited = fresh([
      { type: "agent_start" },
      toolStart("edit", {
        path: "/tmp/work/main.ts",
        edits: [{ oldText: "a", newText: "b" }],
      }),
    ]);
    const written = fresh([
      { type: "agent_start" },
      toolStart("write", { path: "/tmp/work/new.ts", content: "b" }),
    ]);
    const other = fresh([{ type: "agent_start" }, toolStart("grep", { pattern: "todo" })]);

    expect(only(edited, "item.started")[0]?.kind).toBe("file_change");
    expect(only(written, "item.started")[0]?.kind).toBe("file_change");
    expect(only(other, "item.started")[0]?.kind).toBe("tool_call");
  });
});

describe("how a turn that did not simply finish ends", () => {
  const stopping = (stopReason: string, extra: Record<string, unknown> = {}) => [
    { type: "agent_start" },
    { type: "turn_end", message: { ...message(TEXT), stopReason, ...extra }, toolResults: [] },
    {
      type: "agent_end",
      messages: [{ ...message(TEXT), stopReason, ...extra }],
      willRetry: false,
    },
    { type: "agent_settled" },
  ];

  it("reports a turn the user stopped as interrupted", () => {
    const events = fresh(stopping("aborted"));

    expect(only(events, "turn.completed")[0]?.state).toBe("interrupted");
  });

  it("reports a turn that errored as failed, in the words pi used", () => {
    const events = fresh(stopping("error", { errorMessage: "1210 thinking is not supported" }));

    const completed = only(events, "turn.completed")[0];
    expect(completed?.state).toBe("failed");
    expect(completed?.error).toContain("1210");
    // The failure is reported as it happens too: a turn state alone is a row
    // that says something went wrong without saying what.
    expect(only(events, "runtime.error")[0]?.class).toBe("agent_error");
  });

  it("carries one turn across pi's own retry, and prices both attempts", () => {
    const events = fresh([
      { type: "agent_start" },
      { type: "turn_end", message: message(TEXT), toolResults: [] },
      { type: "agent_end", messages: [], willRetry: true },
      { type: "agent_start" },
      { type: "turn_end", message: message(TEXT), toolResults: [] },
      { type: "agent_end", messages: [message(TEXT)], willRetry: false },
      { type: "agent_settled" },
    ]);

    // One episode: the attempt after a retry is the same turn carrying on.
    expect(only(events, "turn.started")).toHaveLength(1);
    expect(only(events, "turn.completed")).toHaveLength(1);
    // What the failed attempt cost is still spent.
    expect(only(events, "turn.completed")[0]?.costUsd).toBeCloseTo(usage.cost.total * 2, 12);
  });

  it("carries one turn across a compaction and a queued message alike", () => {
    const answered = [
      { type: "turn_end", message: message(TEXT), toolResults: [] },
      { type: "agent_end", messages: [message(TEXT)], willRetry: false },
    ];
    const compacted = fresh([
      { type: "agent_start" },
      ...answered,
      { type: "compaction_start", reason: "threshold" },
      { type: "compaction_end", reason: "overflow", result: null, aborted: false, willRetry: true },
      // pi runs again by itself once it has room, which is the same turn.
      { type: "agent_start" },
      ...answered,
      { type: "agent_settled" },
    ]);
    const queued = fresh([
      { type: "agent_start" },
      ...answered,
      // A steer that landed between the run ending and the session settling.
      { type: "agent_start" },
      ...answered,
      { type: "agent_settled" },
    ]);

    for (const events of [compacted, queued]) {
      expect(only(events, "turn.started")).toHaveLength(1);
      expect(only(events, "turn.completed")).toHaveLength(1);
      expect(only(events, "turn.completed")[0]?.costUsd).toBeCloseTo(usage.cost.total * 2, 12);
    }
  });

  it("reports a failure pi retried and gave up on once, not twice", () => {
    const events = fresh([
      { type: "agent_start" },
      {
        type: "agent_end",
        messages: [{ ...message(TEXT), stopReason: "error", errorMessage: "529 overloaded" }],
        willRetry: false,
      },
      // pi says the attempts are over after the run that ended them.
      { type: "auto_retry_end", success: false, attempt: 3, finalError: "529 overloaded" },
    ]);

    expect(only(events, "runtime.error")).toHaveLength(1);
    expect(only(events, "runtime.error")[0]?.class).toBe("agent_error");
  });

  it("says an answer was cut at the output limit, and still ends the turn normally", () => {
    const events = fresh([
      { type: "agent_start" },
      { type: "turn_end", message: { ...message(TEXT), stopReason: "length" }, toolResults: [] },
      { type: "agent_settled" },
    ]);

    expect(only(events, "runtime.warning")[0]?.message).toContain("cut short");
    expect(only(events, "turn.completed")[0]?.state).toBe("completed");
  });

  it("closes the items still running when the turn ends", () => {
    const events = fresh([
      { type: "agent_start" },
      { type: "message_start", message: message([], ZERO) },
      delta({ type: "text_start", contentIndex: 0 }),
      toolStart("bash", { command: "sleep 100" }),
      { type: "agent_settled" },
    ]);

    // A tool whose result never came and a block pi stopped mid-stream: a row
    // nobody closes spins for the rest of the session.
    expect(only(events, "item.completed").map((event) => event.status)).toEqual([
      "failed",
      "failed",
    ]);
    expect(only(events, "item.completed")).toHaveLength(only(events, "item.started").length);
  });

  it("reports what failed around the turn without ending it", () => {
    const extension = fresh([
      { type: "agent_start" },
      {
        type: "extension_error",
        extensionPath: "/tmp/hydra-extension.ts",
        event: "tool_call",
        error: "the gate threw",
      },
    ]);
    const retries = fresh([
      { type: "agent_start" },
      { type: "auto_retry_end", success: false, attempt: 3, finalError: "529 overloaded" },
    ]);

    expect(only(extension, "runtime.error")[0]?.class).toBe("extension_error");
    expect(only(extension, "runtime.error")[0]?.message).toContain("the gate threw");
    expect(only(retries, "runtime.error")[0]?.class).toBe("auto_retry_failed");
    expect(only(retries, "runtime.error")[0]?.message).toContain("529");
    // Neither is the end of the turn: the settle that follows is.
    expect(only(extension, "turn.completed")).toEqual([]);
    expect(only(retries, "turn.completed")).toEqual([]);
  });
});

describe("a line pi wrote that is not an event", () => {
  it("warns about it and carries on with the next one", () => {
    const running = state();

    const stray = through(running, [{ type: "agent_start" }]).concat(
      normalize(running, "pi: warning, something on stdout that is not JSON"),
    );
    const after = through(running, [{ type: "agent_settled" }]);

    expect(only(stray, "runtime.warning")).toHaveLength(1);
    expect(only(stray, "runtime.warning")[0]?.message ?? "").not.toBe("");
    // Not the line itself: what pi could not frame is as likely to be a
    // credential in a stack trace as a complaint.
    expect(only(stray, "runtime.warning")[0]?.message).not.toContain("something on stdout");
    // Skipped, not decoded into something: the line said nothing about a turn.
    expect(tags(stray)).toEqual(["turn.started", "runtime.warning"]);
    expect(tags(after)).toContain("turn.completed");
  });
});
