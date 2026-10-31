/**
 * Tests for the Codex normalizer, which takes one decoded app-server
 * notification and a per-thread state, and returns normalized events.
 * Nothing here starts a process.
 *
 * The frames are trimmed from the generated types of codex 0.154.0 under
 * `generated/v2/`: `TurnStartedNotification`, `ItemCompletedNotification`,
 * `ThreadItem`, the four delta notifications,
 * `ThreadTokenUsageUpdatedNotification` and `ErrorNotification`. They keep the
 * fields a normalizer could read and drop the rest; no field is reshaped.
 *
 * Event ids and the `at` timestamp are not checked here.
 */
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { HarnessEvent } from "@hercule/protocol";
import {
  normalize,
  buildNormalizingState,
  restoreUsageReport,
  markUsageIncomplete,
  requireUsageBaseline,
} from "./normalize";

const SESSION = "0199e0e7-0000-7000-8000-0000000000ff";
const THREAD = "0199e0e7-0000-7000-8000-0000000000fe";
const TURN = "0199e0e7-0000-7000-8000-0000000000fd";
const ITEM = "item_0";

/** The channel name every raw payload from this adapter is filed under. */
const SOURCE = "codex.app-server.notification";

/** A notification as the codec passes it on: the method, and the params unchanged. */
interface Note {
  readonly method: string;
  readonly params: unknown;
}

const buildNote = (method: string, params: Record<string, unknown>): Note => ({ method, params });

/** Ignores what the normalizer reports to the runner's log. */
const IGNORE_REPORT = {
  reportUnknownMessage: (): void => undefined,
  reportIgnoredMessage: (): void => undefined,
};

const buildTestState = () => buildNormalizingState(SESSION, THREAD, undefined, IGNORE_REPORT);

const normalizeNotes = (
  running: ReturnType<typeof buildNormalizingState>,
  notes: ReadonlyArray<Note>,
): ReadonlyArray<HarnessEvent> => notes.flatMap((frame) => normalize(running, frame));

/** Normalizes a sequence of notifications against a fresh state, which is the common case. */
const normalizeFromStart = (notes: ReadonlyArray<Note>): ReadonlyArray<HarnessEvent> =>
  normalizeNotes(buildTestState(), notes);

const listEventTags = (events: ReadonlyArray<HarnessEvent>): ReadonlyArray<string> =>
  events.map((event) => event._tag);

const filterByTag = <Tag extends HarnessEvent["_tag"]>(
  events: ReadonlyArray<HarnessEvent>,
  tag: Tag,
): ReadonlyArray<Extract<HarnessEvent, { _tag: Tag }>> =>
  events.filter((event): event is Extract<HarnessEvent, { _tag: Tag }> => event._tag === tag);

/** Builds a `Turn`, trimmed to the fields a normalizer could read. */
const buildTurn = (status: string) => ({
  id: TURN,
  items: [],
  itemsView: "full",
  status,
  error: null,
  startedAt: null,
  completedAt: null,
  durationMs: null,
});

const MESSAGE = {
  type: "agentMessage",
  id: ITEM,
  text: "Hello",
  phase: null,
  memoryCitation: null,
  delivery: null,
  questions: null,
};

const TURN_STARTED = buildNote("turn/started", { threadId: THREAD, turn: buildTurn("inProgress") });

const ITEM_STARTED = buildNote("item/started", {
  item: { ...MESSAGE, text: "" },
  threadId: THREAD,
  turnId: TURN,
  startedAtMs: 1789373122124,
});

const buildDeltaNote = (method: string, extra: Record<string, unknown>): Note =>
  buildNote(method, { threadId: THREAD, turnId: TURN, itemId: ITEM, ...extra });

const ITEM_COMPLETED = buildNote("item/completed", {
  item: MESSAGE,
  threadId: THREAD,
  turnId: TURN,
  completedAtMs: 1789373123124,
});

const buildTurnCompleted = (status: string): Note =>
  buildNote("turn/completed", { threadId: THREAD, turn: buildTurn(status) });

describe("what a whole Codex turn normalizes to", () => {
  it("reports the turn, the item, its deltas and both completions, in that order", () => {
    const events = normalizeFromStart([
      TURN_STARTED,
      ITEM_STARTED,
      buildDeltaNote("item/agentMessage/delta", { delta: "Hel" }),
      buildDeltaNote("item/agentMessage/delta", { delta: "lo" }),
      ITEM_COMPLETED,
      buildTurnCompleted("completed"),
    ]);

    expect(listEventTags(events)).toEqual([
      "turn.started",
      "item.started",
      "content.delta",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(filterByTag(events, "turn.started")[0]).toMatchObject({ turnId: TURN });
    expect(filterByTag(events, "item.started")[0]).toMatchObject({
      turnId: TURN,
      itemId: ITEM,
      kind: "assistant_message",
    });
    expect(filterByTag(events, "content.delta").map((event) => event.delta)).toEqual(["Hel", "lo"]);
    expect(filterByTag(events, "item.completed")[0]).toMatchObject({
      itemId: ITEM,
      status: "completed",
    });
    expect(filterByTag(events, "turn.completed")[0]).toMatchObject({
      turnId: TURN,
      state: "completed",
    });
  });

  it("files every event under the app-server channel and includes the native thread id", () => {
    const events = normalizeFromStart([
      TURN_STARTED,
      ITEM_STARTED,
      buildDeltaNote("item/agentMessage/delta", { delta: "Hel" }),
      ITEM_COMPLETED,
      buildTurnCompleted("completed"),
    ]);

    expect(events).not.toEqual([]);
    for (const event of events) {
      // Without the thread id, nothing links the event to the native thread.
      expect(event.harnessRefs?.["threadId"]).toBe(THREAD);
      // A delta has no copy of its frame: a turn has thousands of deltas, and
      // the event already holds the delta itself. Every other event names the
      // channel of the payload it holds.
      expect(event.raw?.source).toBe(event._tag === "content.delta" ? undefined : SOURCE);
    }
  });

  it("maps each Codex end status to the matching turn state", () => {
    const ends: ReadonlyArray<readonly [string, string]> = [
      ["completed", "completed"],
      ["failed", "failed"],
      ["interrupted", "interrupted"],
    ];

    for (const [status, ended] of ends) {
      const events = normalizeFromStart([TURN_STARTED, buildTurnCompleted(status)]);

      expect(filterByTag(events, "turn.completed")[0]?.state, status).toBe(ended);
    }
  });

  it("emits no turn.completed for a turn that is still running", () => {
    // The notification may carry `inProgress`. Reporting that as a completion
    // would mark the turn as ended downstream.
    const events = normalizeFromStart([TURN_STARTED, buildTurnCompleted("inProgress")]);

    expect(filterByTag(events, "turn.completed")).toEqual([]);
  });
});

/**
 * One trimmed `ThreadItem` per union member, with the kind it maps to, or
 * `null` when it is not reported at all.
 */
const ITEMS: ReadonlyArray<readonly [Record<string, unknown>, string | null]> = [
  // `userMessage` is Codex echoing back what Hercule sent. The adapter reports
  // that input itself, including whether it steered the turn, which the echo
  // does not include. So the echo is dropped rather than reported twice.
  [{ type: "userMessage", id: "i1", clientId: null, content: [] }, null],
  [{ type: "agentMessage", id: "i2", text: "hi" }, "assistant_message"],
  [{ type: "reasoning", id: "i3", summary: ["thought"], content: [] }, "reasoning"],
  [
    {
      type: "commandExecution",
      id: "i4",
      command: "echo hi",
      cwd: "/tmp/work",
      status: "completed",
      commandActions: [],
      aggregatedOutput: "hi\n",
      exitCode: 0,
    },
    "command_execution",
  ],
  [{ type: "fileChange", id: "i5", changes: [], status: "completed" }, "file_change"],
  [
    { type: "mcpToolCall", id: "i6", server: "files", tool: "read", status: "completed" },
    "tool_call",
  ],
  [{ type: "dynamicToolCall", id: "i7", tool: "lookup", status: "completed" }, "tool_call"],
  [{ type: "functionCallOutput", id: "i8", name: "lookup", output: { content: "" } }, "tool_call"],
  [{ type: "webSearch", id: "i9", query: "codex" }, "web_search"],
  [
    {
      type: "collabAgentToolCall",
      id: "i10",
      tool: "spawn",
      status: "completed",
      senderThreadId: THREAD,
      receiverThreadIds: [],
    },
    "subagent",
  ],
  [
    {
      type: "subAgentActivity",
      id: "i11",
      kind: "started",
      agentThreadId: THREAD,
      agentPath: "/tmp/a",
    },
    "subagent",
  ],
  [{ type: "plan", id: "i12", text: "1. look" }, "plan"],
  [{ type: "contextCompaction", id: "i13" }, "context_compaction"],
  // Hooks are trimmed on purpose (spec 06 section 6.7).
  [{ type: "hookPrompt", id: "i14", fragments: [] }, null],
  [{ type: "imageView", id: "i15", path: "/tmp/a.png" }, "file_read"],
  [{ type: "sleep", id: "i16", durationMs: 10 }, "wait"],
  [{ type: "imageGeneration", id: "i17", status: "completed", result: "" }, "image_generation"],
  // Review mode is shown as a notice and not as an item.
  [{ type: "enteredReviewMode", id: "i18", review: "r" }, null],
  [{ type: "exitedReviewMode", id: "i19", review: "r" }, null],
  // Not in the union at 0.154.0: an item type added by a later release.
  [{ type: "somethingCodexGrew", id: "i20" }, "unknown"],
];

const buildItemCompleted = (item: Record<string, unknown>): Note =>
  buildNote("item/completed", {
    item,
    threadId: THREAD,
    turnId: TURN,
    completedAtMs: 1789373123124,
  });

describe("the text of an assistant message", () => {
  const ASYNC_MESSAGE = {
    type: "agentMessage",
    id: "call_7c2a59c7b036446aaf0aaa6df4e3200f",
    text: "Tool test: Did this structured question reach you?\n- Yes\n- No",
    phase: "final_answer",
    delivery: "async",
    questions: [
      { title: "Tool test: Did this structured question reach you?", options: ["Yes", "No"] },
    ],
  };

  it("reaches the stream as one delta when Codex sends a message with no deltas", () => {
    // The frames captured from codex 0.163.0 for request_user_input_async.
    const events = normalizeFromStart([
      TURN_STARTED,
      buildNote("item/started", { item: ASYNC_MESSAGE, threadId: THREAD, turnId: TURN }),
      buildItemCompleted(ASYNC_MESSAGE),
    ]);

    expect(listEventTags(events)).toEqual([
      "turn.started",
      "item.started",
      "content.delta",
      "item.completed",
    ]);
    expect(filterByTag(events, "content.delta")[0]).toMatchObject({
      itemId: ASYNC_MESSAGE.id,
      streamKind: "assistant_text",
      delta: ASYNC_MESSAGE.text,
    });
  });

  it("is not repeated when the same item completes again", () => {
    const state = buildTestState();

    const events = normalizeNotes(state, [
      TURN_STARTED,
      buildItemCompleted(ASYNC_MESSAGE),
      buildItemCompleted(ASYNC_MESSAGE),
    ]);

    expect(filterByTag(events, "content.delta")).toHaveLength(1);
    expect(filterByTag(events, "item.completed")).toHaveLength(2);
  });

  it("is not repeated for a message that streamed", () => {
    const events = normalizeFromStart([
      TURN_STARTED,
      ITEM_STARTED,
      buildDeltaNote("item/agentMessage/delta", { delta: "Hel" }),
      buildDeltaNote("item/agentMessage/delta", { delta: "lo" }),
      ITEM_COMPLETED,
      ITEM_COMPLETED,
    ]);

    expect(filterByTag(events, "content.delta").map((event) => event.delta)).toEqual(["Hel", "lo"]);
  });

  it("adds nothing for a message with no text", () => {
    const events = normalizeFromStart([buildItemCompleted({ ...MESSAGE, text: "" })]);

    expect(filterByTag(events, "content.delta")).toEqual([]);
  });
});

describe("the kind each Codex item is reported as", () => {
  it("maps every item type in this release, and reports any other type as unknown", () => {
    for (const [item, kind] of ITEMS) {
      const events = normalizeFromStart([buildItemCompleted(item)]);

      expect(
        filterByTag(events, "item.completed").map((event) => event.kind),
        item["type"] as string,
      ).toEqual(kind === null ? [] : [kind]);
    }
  });

  it("keeps the payload of an unknown item type in raw, so nothing is lost", () => {
    const item = { type: "somethingCodexGrew", id: "i20", note: "kept" };

    const events = normalizeFromStart([buildItemCompleted(item)]);

    const reported = filterByTag(events, "item.completed")[0];
    expect(reported?.kind).toBe("unknown");
    expect(reported?.raw).toMatchObject({ source: SOURCE });
    expect(JSON.stringify(reported?.raw?.payload)).toContain("somethingCodexGrew");
  });

  it("reports a command and a patch the user declined as declined, not as failed", () => {
    // A declined item is the user's decision. A surface that showed it as a
    // failure would make the agent look broken.
    const command = normalizeFromStart([
      buildItemCompleted({
        type: "commandExecution",
        id: "i4",
        command: "rm -rf /",
        cwd: "/tmp/work",
        status: "declined",
        commandActions: [],
      }),
    ]);
    const patch = normalizeFromStart([
      buildItemCompleted({ type: "fileChange", id: "i5", changes: [], status: "declined" }),
    ]);

    expect(filterByTag(command, "item.completed")[0]?.status).toBe("declined");
    expect(filterByTag(patch, "item.completed")[0]?.status).toBe("declined");
  });
});

const REASONING = "reason_0";

const buildReasoningNote = (method: string, extra: Record<string, unknown>): Note =>
  buildNote(method, { threadId: THREAD, turnId: TURN, itemId: REASONING, ...extra });

const buildSummaryDelta = (text: string): Note =>
  buildReasoningNote("item/reasoning/summaryTextDelta", { delta: text, summaryIndex: 0 });

const buildRawDelta = (text: string): Note =>
  buildReasoningNote("item/reasoning/textDelta", { delta: text, contentIndex: 0 });

const listStreamedDeltas = (
  events: ReadonlyArray<HarnessEvent>,
): ReadonlyArray<readonly [string, string]> =>
  filterByTag(events, "content.delta").map((event) => [event.streamKind, event.delta] as const);

describe("which reasoning channel a session streams", () => {
  it("streams the summary when the summary is all Codex sends", () => {
    const events = normalizeFromStart([
      TURN_STARTED,
      buildSummaryDelta("Weighing "),
      buildSummaryDelta("the options"),
    ]);

    expect(listStreamedDeltas(events)).toEqual([
      ["reasoning_text", "Weighing "],
      ["reasoning_text", "the options"],
    ]);
  });

  it("streams only raw reasoning when raw arrives first", () => {
    const running = buildTestState();
    normalizeNotes(running, [TURN_STARTED]);

    const first = normalizeNotes(running, [buildRawDelta("Because ")]);
    const second = normalizeNotes(running, [buildSummaryDelta("Weighing the options")]);

    expect(listStreamedDeltas(first)).toEqual([["reasoning_text", "Because "]]);
    // The summary repeats the same reasoning: emitting both would double the
    // item's text, and there is no separate stream kind for summaries.
    expect(listStreamedDeltas(second)).toEqual([]);
  });

  it("switches to raw when raw follows a summary, and drops the summary after it", () => {
    const running = buildTestState();
    normalizeNotes(running, [TURN_STARTED]);

    const opened = normalizeNotes(running, [buildSummaryDelta("Weighing ")]);
    const switched = normalizeNotes(running, [buildRawDelta("Because ")]);
    const after = normalizeNotes(running, [
      buildSummaryDelta("the options"),
      buildRawDelta("it is faster"),
    ]);

    expect(listStreamedDeltas(opened)).toEqual([["reasoning_text", "Weighing "]]);
    expect(listStreamedDeltas(switched)).toEqual([["reasoning_text", "Because "]]);
    expect(listStreamedDeltas(after)).toEqual([["reasoning_text", "it is faster"]]);
  });

  it("streams an assistant message as assistant text and a command's output as command output", () => {
    const message = normalizeFromStart([
      TURN_STARTED,
      buildDeltaNote("item/agentMessage/delta", { delta: "Hello" }),
    ]);
    const output = normalizeFromStart([
      TURN_STARTED,
      buildDeltaNote("item/commandExecution/outputDelta", { delta: "hi\n" }),
    ]);

    expect(listStreamedDeltas(message)).toEqual([["assistant_text", "Hello"]]);
    expect(listStreamedDeltas(output)).toEqual([["command_output", "hi\n"]]);
  });
});

const buildTokenBreakdown = (input: number, cached: number, output: number) => ({
  totalTokens: input + output,
  inputTokens: input,
  cachedInputTokens: cached,
  cacheWriteInputTokens: 0,
  outputTokens: output,
  reasoningOutputTokens: 0,
});

/**
 * Builds a token usage notification. `total` is the thread's whole history,
 * which on a resumed or forked thread includes tokens an earlier process
 * spent; `last` is the most recent model call.
 */
const buildUsageNote = (
  total: ReturnType<typeof buildTokenBreakdown>,
  last: ReturnType<typeof buildTokenBreakdown>,
): Note =>
  buildNote("thread/tokenUsage/updated", {
    threadId: THREAD,
    turnId: TURN,
    tokenUsage: { total, last, modelContextWindow: 272000 },
  });

const buildErrorNote = (
  codexErrorInfo: unknown,
  options: { readonly willRetry?: boolean } = {},
): Note =>
  buildNote("error", {
    error: {
      message: "the model provider rejected the request",
      codexErrorInfo,
      additionalDetails: null,
      misalignment: null,
    },
    willRetry: options.willRetry ?? false,
    threadId: THREAD,
    turnId: TURN,
  });

describe("what a session reports about its usage and its errors", () => {
  it("reports a fresh thread's whole total, which grows with every report", () => {
    const events = normalizeFromStart([
      TURN_STARTED,
      // On a fresh thread the first call is the whole total.
      buildUsageNote(buildTokenBreakdown(1000, 0, 300), buildTokenBreakdown(1000, 0, 300)),
      buildUsageNote(buildTokenBreakdown(1500, 0, 400), buildTokenBreakdown(500, 0, 100)),
    ]);

    // The snapshot is the total since this process started, not the last call.
    expect(filterByTag(events, "session.usage.updated").map((event) => event.usage)).toEqual([
      { inputTokens: 1000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { inputTokens: 1500, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
  });

  it("counts a resumed thread from where this process picked it up", () => {
    const history = buildTokenBreakdown(50_000, 0, 5_000);
    const events = normalizeFromStart([
      // Codex reports the restored history right after the resume, before any
      // turn. An earlier process already reported those tokens.
      buildUsageNote(history, buildTokenBreakdown(8_000, 0, 1_000)),
      TURN_STARTED,
      buildUsageNote(buildTokenBreakdown(62_000, 0, 6_000), buildTokenBreakdown(12_000, 0, 1_000)),
      buildUsageNote(buildTokenBreakdown(70_000, 0, 7_000), buildTokenBreakdown(8_000, 0, 1_000)),
    ]);

    expect(filterByTag(events, "session.usage.updated").map((event) => event.usage)).toEqual([
      { inputTokens: 12_000, outputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { inputTokens: 20_000, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
  });

  it("counts a forked thread from its parent's total, even with no restored report before the turn", () => {
    const events = normalizeFromStart([
      TURN_STARTED,
      buildUsageNote(buildTokenBreakdown(40_000, 0, 4_000), buildTokenBreakdown(3_000, 0, 200)),
    ]);

    expect(filterByTag(events, "session.usage.updated")[0]?.usage).toEqual({
      inputTokens: 3_000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("counts a forked thread from its parent's total when the restored report comes first", () => {
    const events = normalizeFromStart([
      buildUsageNote(buildTokenBreakdown(37_000, 0, 3_800), buildTokenBreakdown(5_000, 0, 300)),
      TURN_STARTED,
      buildUsageNote(buildTokenBreakdown(40_000, 0, 4_000), buildTokenBreakdown(3_000, 0, 200)),
    ]);

    expect(filterByTag(events, "session.usage.updated").map((event) => event.usage)).toEqual([
      { inputTokens: 3_000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
  });

  it("adds nothing when Codex repeats the restored total after a cancelled first call", () => {
    const restored = buildUsageNote(
      buildTokenBreakdown(50_000, 0, 5_000),
      buildTokenBreakdown(8_000, 0, 1_000),
    );
    const events = normalizeFromStart([
      restored,
      TURN_STARTED,
      // A cancelled call makes Codex send the unchanged total and last again.
      restored,
      buildUsageNote(buildTokenBreakdown(70_000, 0, 7_000), buildTokenBreakdown(20_000, 0, 2_000)),
    ]);

    expect(filterByTag(events, "session.usage.updated").map((event) => event.usage)).toEqual([
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { inputTokens: 20_000, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
  });

  it("adds nothing for a compaction, which keeps the total and estimates the last call", () => {
    const events = normalizeFromStart([
      TURN_STARTED,
      buildUsageNote(buildTokenBreakdown(1_000, 0, 300), buildTokenBreakdown(1_000, 0, 300)),
      buildUsageNote(buildTokenBreakdown(1_000, 0, 300), buildTokenBreakdown(200, 0, 0)),
    ]);

    expect(filterByTag(events, "session.usage.updated").map((event) => event.usage)).toEqual([
      { inputTokens: 1_000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { inputTokens: 1_000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ]);
  });

  it("never goes down when Codex resets its total, and counts the next call in full", () => {
    // When the context window overflows, Codex resets the total's counts to zero.
    const reset = buildTokenBreakdown(0, 0, 0);
    const events = normalizeFromStart([
      TURN_STARTED,
      buildUsageNote(buildTokenBreakdown(1_000, 0, 300), buildTokenBreakdown(1_000, 0, 300)),
      buildUsageNote(reset, buildTokenBreakdown(1_000, 0, 300)),
      buildUsageNote(buildTokenBreakdown(400, 100, 50), buildTokenBreakdown(400, 100, 50)),
    ]);

    expect(filterByTag(events, "session.usage.updated").map((event) => event.usage)).toEqual([
      { inputTokens: 1_000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { inputTokens: 1_000, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { inputTokens: 1_300, outputTokens: 350, cacheReadTokens: 100, cacheWriteTokens: 0 },
    ]);
  });

  it("does not count cached input twice", () => {
    // Codex counts cached reads inside its input: 100k input, 90k of it cached.
    const call = buildTokenBreakdown(100_000, 90_000, 2_000);
    const events = normalizeFromStart([TURN_STARTED, buildUsageNote(call, call)]);

    // The four parts never overlap, so they add up to the tokens used.
    expect(filterByTag(events, "session.usage.updated")[0]?.usage).toEqual({
      inputTokens: 10_000,
      outputTokens: 2_000,
      cacheReadTokens: 90_000,
      cacheWriteTokens: 0,
    });
  });

  it("reports Codex's error class, whether it is a string or an object key", () => {
    const string = normalizeFromStart([buildErrorNote("usageLimitExceeded")]);
    const object = normalizeFromStart([
      buildErrorNote({ httpConnectionFailed: { httpStatusCode: 503 } }),
    ]);
    const absent = normalizeFromStart([buildErrorNote(null)]);

    expect(filterByTag(string, "runtime.error")[0]?.class).toBe("usageLimitExceeded");
    expect(filterByTag(object, "runtime.error")[0]?.class).toBe("httpConnectionFailed");
    // An error with no class is still reported, so it is not lost.
    expect(filterByTag(absent, "runtime.error")[0]?.class).toBe("unknown");
  });

  it("emits a warning, not an error, when Codex is retrying by itself", () => {
    const events = normalizeFromStart([buildErrorNote("serverOverloaded", { willRetry: true })]);

    expect(listEventTags(events)).toEqual(["runtime.warning"]);
    expect(filterByTag(events, "runtime.warning")[0]?.message).not.toBe("");
  });
});

const readItemDetail = (events: ReadonlyArray<HarnessEvent>): unknown =>
  filterByTag(events, "item.completed")[0]?.detail;

describe("the detail a surface shows for an item without opening it", () => {
  it("includes the command a shell item ran and the paths a patch touched", () => {
    const command = normalizeFromStart([
      buildItemCompleted({
        type: "commandExecution",
        id: "i4",
        command: "pnpm test",
        cwd: "/tmp/work",
        status: "completed",
        commandActions: [],
      }),
    ]);
    const one = normalizeFromStart([
      buildItemCompleted({
        type: "fileChange",
        id: "i5",
        status: "completed",
        changes: [{ path: "/tmp/work/a.ts", kind: "update", diff: "" }],
      }),
    ]);
    const many = normalizeFromStart([
      buildItemCompleted({
        type: "fileChange",
        id: "i6",
        status: "completed",
        changes: [
          { path: "/tmp/work/a.ts", kind: "update", diff: "" },
          { path: "/tmp/work/b.ts", kind: "add", diff: "" },
        ],
      }),
    ]);

    expect(readItemDetail(command)).toEqual({ command: "pnpm test" });
    expect(readItemDetail(one)).toEqual({ path: "/tmp/work/a.ts" });
    expect(readItemDetail(many)).toEqual({ paths: ["/tmp/work/a.ts", "/tmp/work/b.ts"] });
  });

  it("lists both the old and the new path of a rename", () => {
    const events = normalizeFromStart([
      buildItemCompleted({
        type: "fileChange",
        id: "i10",
        status: "completed",
        changes: [
          {
            path: "/tmp/work/old.ts",
            kind: { type: "update", move_path: "/tmp/work/new.ts" },
            diff: "",
          },
        ],
      }),
    ]);
    expect(readItemDetail(events)).toEqual({ paths: ["/tmp/work/old.ts", "/tmp/work/new.ts"] });
  });

  it("writes a long path whole and leaves out one over 512 characters", () => {
    const whole = `/work/${"d/".repeat(200)}a.ts`;
    const tooLong = `/${"a".repeat(512)}`;
    const detailOf = (paths: ReadonlyArray<string>) =>
      readItemDetail(
        normalizeFromStart([
          buildItemCompleted({
            type: "fileChange",
            id: "i11",
            status: "completed",
            changes: paths.map((path) => ({ path, kind: { type: "add" }, diff: "" })),
          }),
        ]),
      );
    expect(whole.length).toBeGreaterThan(400);
    expect(detailOf([whole, tooLong])).toEqual({ path: whole });
    expect(detailOf([tooLong])).toBeUndefined();
  });

  it("includes the name of the tool called, and whether it is an MCP or a native tool", () => {
    const mcp = normalizeFromStart([
      buildItemCompleted({
        type: "mcpToolCall",
        id: "i7",
        server: "files",
        tool: "read",
        status: "completed",
      }),
    ]);
    const dynamic = normalizeFromStart([
      buildItemCompleted({
        type: "dynamicToolCall",
        id: "i8",
        tool: "lookup",
        status: "completed",
      }),
    ]);
    const output = normalizeFromStart([
      buildItemCompleted({
        type: "functionCallOutput",
        id: "i9",
        name: "lookup",
        output: { content: "" },
      }),
    ]);

    expect(readItemDetail(mcp)).toEqual({ name: "files/read", kind: "mcp" });
    expect(readItemDetail(dynamic)).toEqual({ name: "lookup", kind: "native" });
    expect(readItemDetail(output)).toEqual({ name: "lookup", kind: "native" });
  });

  it("includes the path of the image an image view read, and no detail for an empty path", () => {
    const viewed = normalizeFromStart([
      buildItemCompleted({ type: "imageView", id: "i15", path: "/tmp/shot.png" }),
    ]);
    const unnamed = normalizeFromStart([
      buildItemCompleted({ type: "imageView", id: "i16", path: "" }),
    ]);

    expect(readItemDetail(viewed)).toEqual({ path: "/tmp/shot.png" });
    expect(readItemDetail(unnamed)).toBeUndefined();
  });

  it("includes a web search's query and the collab tool a subagent used", () => {
    const search = normalizeFromStart([
      buildItemCompleted({ type: "webSearch", id: "i10", query: "codex app-server" }),
    ]);
    const collab = normalizeFromStart([
      buildItemCompleted({
        type: "collabAgentToolCall",
        id: "i11",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: THREAD,
        receiverThreadIds: [],
      }),
    ]);

    expect(readItemDetail(search)).toEqual({ description: "codex app-server" });
    expect(readItemDetail(collab)).toEqual({ name: "spawnAgent" });
  });

  it("has no detail for an item that is shown by its own text", () => {
    // A row for a plan or an assistant message shows the item's text, and a
    // detail repeating it would be a second copy to keep in sync.
    for (const item of [
      { type: "agentMessage", id: "i13", text: "hi" },
      { type: "reasoning", id: "i14", summary: [], content: [] },
      { type: "contextCompaction", id: "i15" },
    ]) {
      expect(
        readItemDetail(normalizeFromStart([buildItemCompleted(item)])),
        item.type,
      ).toBeUndefined();
    }
  });

  it("includes the same detail on item.started as on item.completed", () => {
    const opened = normalizeFromStart([
      TURN_STARTED,
      buildNote("item/started", {
        item: {
          type: "commandExecution",
          id: "i4",
          command: "pnpm test",
          cwd: "/tmp/work",
          status: "inProgress",
          commandActions: [],
        },
        threadId: THREAD,
        turnId: TURN,
        startedAtMs: 1789373122124,
      }),
    ]);

    expect(filterByTag(opened, "item.started")[0]?.detail).toEqual({ command: "pnpm test" });
  });
});

const CHILD = "0199e0e7-0000-7000-8000-0000000000fc";
const OTHER_CHILD = "0199e0e7-0000-7000-8000-0000000000fb";

/** Copies a notification onto another native thread without changing its turn or item ids. */
const assignThread = (note: Note, threadId: string): Note => ({
  ...note,
  params: { ...(note.params as Record<string, unknown>), threadId },
});

describe("a subagent's native thread", () => {
  it("attributes every event to its subagent and keeps the native thread id", () => {
    const state = buildNormalizingState(SESSION, CHILD, undefined, IGNORE_REPORT, {
      subagentId: CHILD,
      rootThreadId: THREAD,
    });
    const call = buildTokenBreakdown(100, 80, 20);
    const events = normalizeNotes(
      state,
      [
        TURN_STARTED,
        ITEM_STARTED,
        buildDeltaNote("item/agentMessage/delta", { delta: "Hello" }),
        ITEM_COMPLETED,
        buildUsageNote(call, call),
        buildErrorNote("serverOverloaded", { willRetry: true }),
        buildErrorNote("usageLimitExceeded"),
        buildTurnCompleted("completed"),
      ].map((note) => assignThread(note, CHILD)),
    );

    expect(events).toHaveLength(8);
    for (const event of events) {
      expect(event).toMatchObject({
        sessionId: SESSION,
        subagentId: CHILD,
        harnessRefs: { threadId: CHILD },
      });
      expect(Schema.is(HarnessEvent)(event), event._tag).toBe(true);
    }
  });

  it("retains a child's native input and ignores the root's echo of already reported input", () => {
    const input = buildItemCompleted({
      type: "userMessage",
      id: "brief",
      clientId: null,
      content: [
        { type: "text", text: "Inspect the parser.", text_elements: [] },
        { type: "localImage", path: "/tmp/context.png" },
        { type: "text", text: "Report the result.", text_elements: [] },
      ],
    });
    expect(normalize(buildTestState(), input)).toEqual([]);
    const child = buildNormalizingState(SESSION, CHILD, undefined, IGNORE_REPORT, {
      subagentId: CHILD,
      rootThreadId: THREAD,
    });
    const started = assignThread(
      buildNote("item/started", input.params as Record<string, unknown>),
      CHILD,
    );
    const events = normalizeNotes(child, [
      assignThread(TURN_STARTED, CHILD),
      started,
      assignThread(input, CHILD),
    ]);
    expect(listEventTags(events)).toEqual(["turn.started", "item.started", "item.completed"]);
    for (const event of events.slice(1)) {
      expect(event).toMatchObject({
        subagentId: CHILD,
        itemId: "brief",
        kind: "user_message",
        detail: { text: "Inspect the parser.\nReport the result." },
      });
    }
  });

  it("keeps reasoning channels, models and structured answers independent when frames interleave", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["result"],
      properties: { result: { type: "string" } },
    } as const;
    const root = buildNormalizingState(SESSION, THREAD, schema, IGNORE_REPORT);
    const child = buildNormalizingState(SESSION, CHILD, schema, IGNORE_REPORT, {
      subagentId: CHILD,
      rootThreadId: THREAD,
    });
    root.model = "root-model";
    child.model = "child-model";
    expect(normalize(root, TURN_STARTED)[0]).toMatchObject({ model: "root-model" });
    expect(normalize(child, assignThread(TURN_STARTED, CHILD))[0]).toMatchObject({
      model: "child-model",
      subagentId: CHILD,
    });
    normalize(root, buildRawDelta("root raw"));
    expect(
      listStreamedDeltas(normalize(child, assignThread(buildSummaryDelta("child summary"), CHILD))),
    ).toEqual([["reasoning_text", "child summary"]]);
    normalize(root, buildItemCompleted({ ...MESSAGE, text: '{"result":"root answer"}' }));
    normalize(child, assignThread(buildItemCompleted({ ...MESSAGE, text: "child prose" }), CHILD));
    expect(
      normalize(child, assignThread(buildTurnCompleted("completed"), CHILD))[0],
    ).not.toHaveProperty("structuredResult");
    expect(normalize(root, buildSummaryDelta("duplicate root summary"))).toEqual([]);
    expect(normalize(root, buildTurnCompleted("completed"))[0]).toMatchObject({
      structuredResult: { outcome: "ok", value: { result: "root answer" } },
    });
  });

  it("counts cached usage, repeated reports and resets independently for concurrent threads", () => {
    const root = buildTestState();
    const child = buildNormalizingState(SESSION, CHILD, undefined, IGNORE_REPORT, {
      subagentId: CHILD,
      rootThreadId: THREAD,
    });
    normalize(root, TURN_STARTED);
    normalize(child, assignThread(TURN_STARTED, CHILD));
    const rootCall = buildTokenBreakdown(1_000, 900, 100);
    const childCall = buildTokenBreakdown(400, 100, 50);
    normalize(root, buildUsageNote(rootCall, rootCall));
    normalize(child, assignThread(buildUsageNote(childCall, childCall), CHILD));
    expect(
      filterByTag(normalize(root, buildUsageNote(rootCall, rootCall)), "session.usage.updated")[0]
        ?.usage,
    ).toEqual({ inputTokens: 100, outputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0 });
    normalize(child, assignThread(buildUsageNote(buildTokenBreakdown(0, 0, 0), childCall), CHILD));
    const nextCall = buildTokenBreakdown(200, 50, 20);
    expect(
      filterByTag(
        normalize(child, assignThread(buildUsageNote(nextCall, nextCall), CHILD)),
        "session.usage.updated",
      )[0]?.usage,
    ).toEqual({ inputTokens: 450, outputTokens: 70, cacheReadTokens: 150, cacheWriteTokens: 0 });
    expect(root.counted).toMatchObject({
      inputTokens: 1_000,
      cachedInputTokens: 900,
      outputTokens: 100,
    });
  });
});

describe("the subagents named by a native item", () => {
  it("never links the session's root as a subagent, including when a child targets it", () => {
    const child = buildNormalizingState(SESSION, CHILD, undefined, IGNORE_REPORT, {
      subagentId: CHILD,
      rootThreadId: THREAD,
    });
    const events = normalizeNotes(child, [
      assignThread(
        buildItemCompleted({
          type: "collabAgentToolCall",
          id: ITEM,
          tool: "sendMessage",
          status: "completed",
          senderThreadId: CHILD,
          receiverThreadIds: [THREAD, OTHER_CHILD],
          prompt: "The parser is valid.",
          agentsStates: {},
        }),
        CHILD,
      ),
    ]);
    expect(readItemDetail(events)).toEqual({
      name: "sendMessage",
      subagentIds: [OTHER_CHILD],
      description: "The parser is valid.",
    });
    const activity = normalize(
      child,
      assignThread(
        buildItemCompleted({
          type: "subAgentActivity",
          id: ITEM,
          kind: "interacted",
          agentThreadId: THREAD,
          agentPath: "root",
        }),
        CHILD,
      ),
    );
    expect(readItemDetail(activity)).toEqual({ name: "interacted" });
  });

  it.each([
    "spawnAgent",
    "sendInput",
    "resumeAgent",
    "wait",
    "closeAgent",
    "sendMessage",
    "followupTask",
    "interruptAgent",
  ])("links every receiver of %s", (tool) => {
    const events = normalizeFromStart([
      buildItemCompleted({
        type: "collabAgentToolCall",
        id: ITEM,
        tool,
        status: "completed",
        senderThreadId: THREAD,
        receiverThreadIds: [CHILD, OTHER_CHILD],
        prompt: "Check the parser.",
        agentsStates: {},
      }),
    ]);
    expect(readItemDetail(events)).toMatchObject({ name: tool, subagentIds: [CHILD, OTHER_CHILD] });
  });

  it.each(["started", "interacted", "completed", "interrupted"])(
    "links the native agent of V2 %s activity",
    (kind) => {
      const events = normalizeFromStart([
        buildItemCompleted({
          type: "subAgentActivity",
          id: ITEM,
          kind,
          agentThreadId: CHILD,
          agentPath: "root/parser",
        }),
      ]);
      expect(readItemDetail(events)).toMatchObject({ name: kind, subagentIds: [CHILD] });
      expect(filterByTag(events, "item.completed")[0]?.status).toBe(
        kind === "interrupted" ? "failed" : "completed",
      );
    },
  );

  it("keeps failed and interrupted V1 calls failed without changing a receiver's turn", () => {
    for (const status of ["failed", "interrupted"]) {
      const events = normalizeFromStart([
        buildItemCompleted({
          type: "collabAgentToolCall",
          id: ITEM,
          tool: "wait",
          status,
          senderThreadId: THREAD,
          receiverThreadIds: [CHILD],
          prompt: null,
          agentsStates: {},
        }),
      ]);
      expect(listEventTags(events)).toEqual(["item.completed"]);
      expect(filterByTag(events, "item.completed")[0]).toMatchObject({
        kind: "subagent",
        status: "failed",
        detail: { subagentIds: [CHILD] },
      });
    }
  });
});

describe("restoring a saved Codex counter report", () => {
  it("counts zero for a cancelled first call after resume and counts only new growth", () => {
    const state = buildTestState();
    const history = buildTokenBreakdown(50000, 10000, 5000);
    expect(
      restoreUsageReport(state, {
        source: SOURCE,
        payload: buildUsageNote(history, buildTokenBreakdown(8000, 1000, 1000)).params,
      }),
    ).toBe(true);
    const events = normalizeNotes(state, [
      TURN_STARTED,
      buildUsageNote(history, buildTokenBreakdown(8000, 1000, 1000)),
      buildUsageNote(
        buildTokenBreakdown(62000, 13000, 6000),
        buildTokenBreakdown(12000, 3000, 1000),
      ),
    ]);
    expect(filterByTag(events, "session.usage.updated").map((event) => event.usage)).toEqual([
      { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { inputTokens: 9000, outputTokens: 1000, cacheReadTokens: 3000, cacheWriteTokens: 0 },
    ]);
  });

  it.each([
    undefined,
    null,
    { source: "other-provider", payload: {} },
    {
      source: SOURCE,
      payload: {
        threadId: "different-thread",
        tokenUsage: { total: buildTokenBreakdown(100, 0, 10) },
      },
    },
    { source: SOURCE, payload: { threadId: THREAD, tokenUsage: { total: {} } } },
    ...[-1, NaN, Infinity, 1.5, "100"].map((inputTokens) => ({
      source: SOURCE,
      payload: {
        threadId: THREAD,
        tokenUsage: { total: { ...buildTokenBreakdown(100, 0, 10), inputTokens } },
      },
    })),
  ])("rejects an unusable saved report without partially seeding state: %j", (report) => {
    const state = buildTestState();
    expect(restoreUsageReport(state, report)).toBe(false);
    expect(state.previousTotal).toBeUndefined();
    expect(state.counted).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
    });
  });
});

describe("incomplete Codex token accounting", () => {
  it("baselines the first report after failed restoration and retains only later growth", () => {
    const state = buildTestState();
    requireUsageBaseline(state);
    const history = buildTokenBreakdown(50000, 10000, 5000);
    const events = normalizeNotes(state, [
      TURN_STARTED,
      buildUsageNote(history, buildTokenBreakdown(8000, 1000, 1000)),
      buildUsageNote(
        buildTokenBreakdown(62000, 13000, 6000),
        buildTokenBreakdown(12000, 3000, 1000),
      ),
      buildUsageNote(
        buildTokenBreakdown(62000, 13000, 6000),
        buildTokenBreakdown(12000, 3000, 1000),
      ),
    ]);
    const reports = filterByTag(events, "session.usage.updated");
    expect(reports.map((event) => event.usageReport)).toEqual([
      {
        status: "incomplete",
        counts: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
      {
        status: "incomplete",
        counts: {
          inputTokens: 9000,
          outputTokens: 1000,
          cacheReadTokens: 3000,
          cacheWriteTokens: 0,
        },
      },
      {
        status: "incomplete",
        counts: {
          inputTokens: 9000,
          outputTokens: 1000,
          cacheReadTokens: 3000,
          cacheWriteTokens: 0,
        },
      },
    ]);
    for (const report of reports) expect(report).not.toHaveProperty("usage");
    expect(state.usageBaselineRequired).toBe(false);
  });

  it("preserves an existing counter baseline when dropped frames make accounting incomplete", () => {
    const state = buildTestState();
    const history = buildTokenBreakdown(100, 0, 10);
    restoreUsageReport(state, { source: SOURCE, payload: buildUsageNote(history, history).params });
    markUsageIncomplete(state);
    const events = normalizeNotes(state, [
      TURN_STARTED,
      buildUsageNote(buildTokenBreakdown(150, 0, 20), buildTokenBreakdown(50, 0, 10)),
    ]);
    expect(filterByTag(events, "session.usage.updated")[0]?.usageReport).toEqual({
      status: "incomplete",
      counts: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  });
});

describe("a method or a status named like an object method", () => {
  it("finds no decision for a method named `constructor`, and reports it as unknown", () => {
    const events = normalizeFromStart([buildDeltaNote("constructor", { delta: "x" })]);

    expect(filterByTag(events, "item.completed").map((event) => event.detail)).toEqual([
      { label: "codex: constructor" },
    ]);
  });

  it("does not end a turn whose status is `constructor`", () => {
    const events = normalizeFromStart([TURN_STARTED, buildTurnCompleted("constructor")]);

    expect(listEventTags(events)).not.toContain("turn.completed");
  });
});

/** Encodes every event with the protocol schema, which is what the runner does before it sends one. */
const encodeAll = (events: ReadonlyArray<HarnessEvent>): void => {
  const encode = Schema.encodeUnknownSync(HarnessEvent);
  for (const event of events) expect(() => encode(event), event._tag).not.toThrow();
};

/** Builds a state whose reports about unknown messages are collected in `reports`. */
const buildReportingState = (reports: Array<string>, ignored: Array<string> = []) =>
  buildNormalizingState(SESSION, THREAD, undefined, {
    reportUnknownMessage: (label) => {
      reports.push(label);
    },
    reportIgnoredMessage: (key) => {
      ignored.push(key);
    },
  });

const buildPlanNote = (
  plan: ReadonlyArray<{ readonly step: string; readonly status: string }>,
  turnId: string = TURN,
): Note => buildNote("turn/plan/updated", { threadId: THREAD, turnId, explanation: "why", plan });

describe("the text of a plan", () => {
  it("reaches the completed plan item, whatever the deltas add up to", () => {
    const planItem = { type: "plan", id: "plan_0", text: "1. look\n2. fix" };
    const events = normalizeFromStart([
      TURN_STARTED,
      buildNote("item/started", {
        item: { ...planItem, text: "" },
        threadId: THREAD,
        turnId: TURN,
        startedAtMs: 1,
      }),
      buildDeltaNote("item/plan/delta", { itemId: "plan_0", delta: "1. lo" }),
      buildDeltaNote("item/plan/delta", { itemId: "plan_0", delta: "ok" }),
      buildNote("item/completed", {
        item: planItem,
        threadId: THREAD,
        turnId: TURN,
        completedAtMs: 2,
      }),
    ]);

    expect(listEventTags(events)).toEqual(["turn.started", "item.started", "item.completed"]);
    expect(filterByTag(events, "item.started")[0]?.detail).toBeUndefined();
    expect(filterByTag(events, "item.completed")[0]).toMatchObject({
      kind: "plan",
      detail: { content: "1. look\n2. fix" },
    });
    encodeAll(events);
  });
});

describe("the todo list of Codex's plan", () => {
  const FIRST = [
    { step: "Read the code", status: "completed" },
    { step: "Write the fix", status: "inProgress" },
    { step: "Run the tests", status: "pending" },
  ];
  const FIRST_STEPS = [
    { text: "Read the code", status: "completed" },
    { text: "Write the fix", status: "in_progress" },
    { text: "Run the tests", status: "pending" },
  ];
  const SECOND = [
    { step: "Read the code", status: "completed" },
    { step: "Write the fix", status: "completed" },
    { step: "Run the tests", status: "inProgress" },
  ];

  it("is one item for the turn: started, then updated with the whole list, then completed before the turn", () => {
    const events = normalizeFromStart([
      TURN_STARTED,
      buildPlanNote(FIRST),
      buildPlanNote(SECOND),
      buildTurnCompleted("completed"),
    ]);

    expect(listEventTags(events)).toEqual([
      "turn.started",
      "item.started",
      "item.updated",
      "item.completed",
      "turn.completed",
    ]);
    const todo = events.filter((event) => "kind" in event && event.kind === "todo_list");
    expect(new Set(todo.map((event) => "itemId" in event && event.itemId)).size).toBe(1);
    expect(todo[0]).toMatchObject({ turnId: TURN, detail: { steps: FIRST_STEPS } });
    expect(todo[1]).toMatchObject({
      detail: {
        steps: [
          FIRST_STEPS[0],
          { text: "Write the fix", status: "completed" },
          { text: "Run the tests", status: "in_progress" },
        ],
      },
    });
    expect(todo[2]).toMatchObject({
      status: "completed",
      detail: todo[1] && "detail" in todo[1] ? todo[1].detail : undefined,
    });
    encodeAll(events);
  });

  it("emits nothing for an update that shows what the item already shows", () => {
    const events = normalizeFromStart([TURN_STARTED, buildPlanNote(FIRST), buildPlanNote(FIRST)]);

    expect(listEventTags(events)).toEqual(["turn.started", "item.started"]);
  });

  it.each(["failed", "interrupted"])("completes the list before a turn that %s", (status) => {
    const events = normalizeFromStart([
      TURN_STARTED,
      buildPlanNote(FIRST),
      buildTurnCompleted(status),
    ]);

    expect(listEventTags(events)).toEqual([
      "turn.started",
      "item.started",
      "item.completed",
      "turn.completed",
    ]);
    expect(filterByTag(events, "item.completed")[0]).toMatchObject({ status: "completed" });
  });

  it("starts a new item in the next turn", () => {
    const events = normalizeFromStart([
      TURN_STARTED,
      buildPlanNote(FIRST),
      buildTurnCompleted("completed"),
      {
        ...TURN_STARTED,
        params: { threadId: THREAD, turn: { ...buildTurn("inProgress"), id: "turn_2" } },
      },
      buildPlanNote(FIRST, "turn_2"),
    ]);

    const started = filterByTag(events, "item.started");
    expect(started).toHaveLength(2);
    expect(started[0]?.itemId).not.toBe(started[1]?.itemId);
  });

  it("completes a list left open by a turn whose completion never arrived", () => {
    const events = normalizeFromStart([
      TURN_STARTED,
      buildPlanNote(FIRST),
      {
        ...TURN_STARTED,
        params: { threadId: THREAD, turn: { ...buildTurn("inProgress"), id: "turn_2" } },
      },
    ]);

    expect(listEventTags(events)).toEqual([
      "turn.started",
      "item.started",
      "item.completed",
      "turn.started",
    ]);
  });

  it("ignores an update that names a turn other than the running one", () => {
    const state = buildTestState();

    expect(normalizeNotes(state, [buildPlanNote(FIRST)])).toEqual([]);
    expect(normalizeNotes(state, [TURN_STARTED, buildPlanNote(FIRST, "turn_old")])).toHaveLength(1);
  });

  it("is not closed or cleared by the late completion of another turn", () => {
    const state = buildTestState();
    normalizeNotes(state, [TURN_STARTED, buildPlanNote(FIRST)]);

    const late = normalizeNotes(state, [
      buildNote("turn/completed", {
        threadId: THREAD,
        turn: { ...buildTurn("interrupted"), id: "turn_old" },
      }),
    ]);
    const after = normalizeNotes(state, [buildPlanNote(SECOND), buildTurnCompleted("completed")]);

    expect(listEventTags(late)).toEqual(["turn.completed"]);
    expect(listEventTags(after)).toEqual(["item.updated", "item.completed", "turn.completed"]);
  });

  it("keeps one list per agent", () => {
    const root = buildTestState();
    const child = buildNormalizingState(SESSION, CHILD, undefined, IGNORE_REPORT, {
      subagentId: CHILD,
      rootThreadId: THREAD,
    });
    const childTurn = { ...buildTurn("inProgress"), id: "turn_child" };
    normalizeNotes(root, [TURN_STARTED, buildPlanNote(FIRST)]);
    const childEvents = normalizeNotes(child, [
      buildNote("turn/started", { threadId: CHILD, turn: childTurn }),
      buildPlanNote(SECOND, "turn_child"),
      buildNote("turn/completed", { threadId: CHILD, turn: { ...childTurn, status: "completed" } }),
    ]);
    const rootEnd = normalizeNotes(root, [buildTurnCompleted("completed")]);

    expect(childEvents.map((event) => event._tag)).toEqual([
      "turn.started",
      "item.started",
      "item.completed",
      "turn.completed",
    ]);
    expect(childEvents.every((event) => "subagentId" in event && event.subagentId === CHILD)).toBe(
      true,
    );
    expect(listEventTags(rootEnd)).toEqual(["item.completed", "turn.completed"]);
    encodeAll([...childEvents, ...rootEnd]);
  });

  it("warns instead of cutting a plan of more than 128 steps, and keeps the item as it was", () => {
    const long = Array.from({ length: 129 }, (_, index) => ({
      step: `Step ${index}`,
      status: "pending",
    }));
    const events = normalizeFromStart([TURN_STARTED, buildPlanNote(FIRST), buildPlanNote(long)]);

    expect(listEventTags(events)).toEqual(["turn.started", "item.started", "runtime.warning"]);
    expect(filterByTag(events, "runtime.warning")[0]).toMatchObject({
      turnId: TURN,
      message: "Codex's plan has 129 steps, more than the 128 a todo list can show",
    });
    encodeAll(events);
  });

  it.each([
    ["a step with no text", [{ step: "", status: "pending" }]],
    ["a status this build does not know", [{ step: "Think", status: "blocked" }]],
  ])("reports a plan with %s as unknown, not as a wrong list", (_name, plan) => {
    const events = normalizeFromStart([TURN_STARTED, buildPlanNote(plan)]);

    expect(filterByTag(events, "item.completed").map((event) => event.detail)).toEqual([
      { label: "codex: turn/plan/updated" },
    ]);
    encodeAll(events);
  });
});

describe("the notices and warnings Codex sends", () => {
  it("shows a model switch as a notice in the running turn", () => {
    const rerouted = buildNote("model/rerouted", {
      threadId: THREAD,
      turnId: TURN,
      fromModel: "gpt-a",
      toModel: "gpt-b",
      reason: "highRiskCyberActivity",
    });
    const state = buildTestState();

    const inTurn = normalizeNotes(state, [TURN_STARTED, rerouted]);
    const late = normalizeNotes(state, [
      buildNote("model/rerouted", { ...(rerouted.params as object), turnId: "turn_old" }),
    ]);

    expect(filterByTag(inTurn, "runtime.notice")).toMatchObject([
      { turnId: TURN, message: "Codex switched model from gpt-a to gpt-b" },
    ]);
    expect(filterByTag(late, "runtime.notice")[0]?.turnId).toBeUndefined();
    encodeAll([...inTurn, ...late]);
  });

  it.each([
    ["warning", { threadId: THREAD, message: "Disk is almost full" }, "Disk is almost full"],
    [
      "guardianWarning",
      { threadId: THREAD, message: "Command was blocked" },
      "Command was blocked",
    ],
  ])("draws %s inside the running turn of its thread", (method, params, message) => {
    const running = normalizeFromStart([TURN_STARTED, buildNote(method, params)]);
    const idle = normalizeFromStart([buildNote(method, params)]);

    expect(filterByTag(running, "runtime.warning")).toMatchObject([{ turnId: TURN, message }]);
    expect(listEventTags(idle)).toEqual(["runtime.warning"]);
    expect(filterByTag(idle, "runtime.warning")[0]?.turnId).toBeUndefined();
    encodeAll([...running, ...idle]);
  });

  it.each([
    ["warning", { threadId: null, message: "Disk is almost full" }, "Disk is almost full"],
    ["deprecationNotice", { summary: "Flag x is old", details: "Use y" }, "Flag x is old\nUse y"],
    ["deprecationNotice", { summary: "Flag x is old", details: null }, "Flag x is old"],
    [
      "configWarning",
      { summary: "Bad key", details: "Line 3", path: "/home/u/.codex/config.toml" },
      "Bad key\nLine 3\nConfig file: /home/u/.codex/config.toml",
    ],
    ["configWarning", { summary: "Bad key", details: null }, "Bad key"],
  ])(
    "shows %s, which concerns the whole session, as a warning that names no turn",
    (method, params, message) => {
      const events = normalizeFromStart([TURN_STARTED, buildNote(method, params)]);

      const warnings = filterByTag(events, "runtime.warning");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toBe(message);
      expect(warnings[0]?.turnId).toBeUndefined();
      encodeAll(events);
    },
  );

  it("opens no turn for a warning outside any turn", () => {
    const events = normalizeFromStart([
      buildNote("warning", { threadId: null, message: "Heads up" }),
    ]);

    expect(listEventTags(events)).toEqual(["runtime.warning"]);
  });
});

describe("the items Codex has no tool kind for", () => {
  const buildImage = (extra: Record<string, unknown>) => ({
    type: "imageGeneration",
    id: "img_0",
    status: "completed",
    revisedPrompt: "a cat",
    result: "",
    failure: null,
    ...extra,
  });

  it("shows a sleep as a wait of the length it asked for", () => {
    const events = normalizeFromStart([
      buildItemCompleted({ type: "sleep", id: "s_0", durationMs: 30000 }),
    ]);

    expect(filterByTag(events, "item.completed")[0]).toMatchObject({
      kind: "wait",
      detail: { durationMs: 30000 },
    });
    encodeAll(events);
  });

  it("shows an image generation, with its saved path as an update right before the completion", () => {
    const events = normalizeFromStart([
      TURN_STARTED,
      buildNote("item/started", {
        item: buildImage({ status: "inProgress" }),
        threadId: THREAD,
        turnId: TURN,
        startedAtMs: 1,
      }),
      buildItemCompleted(buildImage({ savedPath: "/tmp/cat.png" })),
    ]);

    expect(listEventTags(events)).toEqual([
      "turn.started",
      "item.started",
      "item.updated",
      "item.completed",
    ]);
    expect(filterByTag(events, "item.started")[0]?.detail).toBeUndefined();
    expect(events.filter((event) => event._tag === "item.updated")[0]).toMatchObject({
      kind: "image_generation",
      itemId: "img_0",
      detail: { path: "/tmp/cat.png" },
    });
    expect(filterByTag(events, "item.completed")[0]).toMatchObject({
      kind: "image_generation",
      status: "completed",
      detail: { path: "/tmp/cat.png" },
    });
    encodeAll(events);
  });

  it("fails a generation that failed, and has no detail without a saved path", () => {
    const events = normalizeFromStart([
      buildItemCompleted(
        buildImage({ status: "failed", failure: { message: "no" }, savedPath: "" }),
      ),
    ]);

    const completed = filterByTag(events, "item.completed")[0];
    expect(completed).toMatchObject({ kind: "image_generation", status: "failed" });
    expect(completed?.detail).toBeUndefined();
    expect(listEventTags(events)).not.toContain("item.updated");
  });

  it("shows entering and leaving review mode as notices, only when the item completes", () => {
    const entered = { type: "enteredReviewMode", id: "r_0", review: "current changes" };
    const exited = { type: "exitedReviewMode", id: "r_1", review: "Found 2 problems ..." };
    const started = normalizeFromStart([
      TURN_STARTED,
      buildNote("item/started", { item: entered, threadId: THREAD, turnId: TURN, startedAtMs: 1 }),
    ]);
    const events = normalizeFromStart([
      TURN_STARTED,
      buildItemCompleted(entered),
      buildItemCompleted(exited),
    ]);

    expect(listEventTags(started)).toEqual(["turn.started"]);
    expect(filterByTag(events, "runtime.notice")).toMatchObject([
      { turnId: TURN, message: "Codex started a review: current changes" },
      { turnId: TURN, message: "Codex finished the review" },
    ]);
    encodeAll(events);
  });

  it("shows nothing for a hook prompt", () => {
    const hook = { type: "hookPrompt", id: "h_0", fragments: [] };

    expect(normalizeFromStart([TURN_STARTED, buildItemCompleted(hook)])).toHaveLength(1);
  });
});

describe("what Codex sends that this build has no decision for", () => {
  const FUTURE = buildNote("future/thing", { threadId: THREAD, turnId: TURN, detail: "x" });

  it("becomes a labelled unknown item in the running turn, with the frame in raw, reported once", () => {
    const reports: Array<string> = [];
    const state = buildReportingState(reports);

    const events = normalizeNotes(state, [TURN_STARTED, FUTURE, FUTURE]);

    expect(listEventTags(events)).toEqual([
      "turn.started",
      "item.started",
      "item.completed",
      "item.started",
      "item.completed",
    ]);
    const [started, completed] = [
      filterByTag(events, "item.started")[0],
      filterByTag(events, "item.completed")[0],
    ];
    // The frame is in `raw` of the first event only.
    expect(started).toMatchObject({
      kind: "unknown",
      turnId: TURN,
      detail: { label: "codex: future/thing" },
      raw: { source: SOURCE, payload: { method: "future/thing" } },
    });
    expect(completed?.raw).toBeUndefined();
    expect(reports).toEqual(["codex: future/thing", "codex: future/thing"]);
    encodeAll(events);
  });

  it("opens a turn that holds only the item when no turn is running", () => {
    const events = normalizeFromStart([buildNote("future/thing", { threadId: THREAD })]);

    expect(listEventTags(events)).toEqual([
      "turn.started",
      "item.started",
      "item.completed",
      "turn.completed",
    ]);
    const turnIds = new Set(events.map((event) => "turnId" in event && event.turnId));
    expect(turnIds.size).toBe(1);
    expect(filterByTag(events, "turn.completed")[0]?.state).toBe("completed");
    encodeAll(events);
  });

  it("puts a frame of another turn in the running turn, and ends no turn", () => {
    const events = normalizeFromStart([
      TURN_STARTED,
      buildNote("future/thing", { threadId: THREAD, turnId: "turn_old" }),
    ]);

    // One agent never has two turns at once: a synthetic turn that ended here
    // would make the controller take the session for idle in the middle of
    // the running turn.
    expect(listEventTags(events)).toEqual(["turn.started", "item.started", "item.completed"]);
    expect(filterByTag(events, "item.completed")[0]?.turnId).toBe(TURN);
    expect(filterByTag(events, "item.started")[0]?.raw).toMatchObject({
      payload: { params: { turnId: "turn_old" } },
    });
  });

  it("draws nothing, and tells the log, while a turn is asked for but has not started", () => {
    const reports: Array<string> = [];
    const state = buildReportingState(reports);
    state.isTurnPending = () => true;

    const events = normalizeNotes(state, [FUTURE]);

    expect(events).toEqual([]);
    expect(reports).toEqual(["codex: future/thing"]);
  });

  it("is what a known method with unreadable params becomes", () => {
    const reports: Array<string> = [];
    const state = buildReportingState(reports);

    const events = normalizeNotes(state, [TURN_STARTED, buildNote("item/completed", {})]);

    expect(filterByTag(events, "item.completed")[0]).toMatchObject({
      kind: "unknown",
      detail: { label: "codex: item/completed" },
    });
    expect(reports).toEqual(["codex: item/completed"]);
    encodeAll(events);
  });

  it.each([
    ["model/rerouted without model names", "model/rerouted", { threadId: THREAD, turnId: TURN }],
    ["a warning whose message is not text", "warning", { threadId: THREAD, message: 5 }],
    ["a config warning whose summary is not text", "configWarning", { summary: {}, details: null }],
    [
      "a deprecation notice whose details are not text",
      "deprecationNotice",
      { summary: "x", details: 7 },
    ],
  ])("is what %s becomes", (_name, method, params) => {
    const events = normalizeFromStart([TURN_STARTED, buildNote(method, params)]);

    expect(filterByTag(events, "runtime.warning")).toEqual([]);
    expect(filterByTag(events, "runtime.notice")).toEqual([]);
    expect(filterByTag(events, "item.completed")[0]).toMatchObject({
      kind: "unknown",
      detail: { label: `codex: ${method}` },
    });
    encodeAll(events);
  });

  it("is what a sleep without a duration becomes", () => {
    const events = normalizeFromStart([
      TURN_STARTED,
      buildItemCompleted({ type: "sleep", id: "s_0", durationMs: "soon" }),
    ]);

    expect(
      filterByTag(events, "item.completed").find((event) => event.kind === "unknown"),
    ).toMatchObject({ detail: { label: "codex: item/sleep" } });
  });

  it("closes the row of an item that started fine and then completed unreadable, as failed", () => {
    const events = normalizeFromStart([
      TURN_STARTED,
      buildNote("item/started", {
        item: { type: "sleep", id: "w", durationMs: 5 },
        threadId: THREAD,
        turnId: TURN,
        startedAtMs: 1,
      }),
      buildItemCompleted({ type: "sleep", id: "w", durationMs: "bad" }),
      buildTurnCompleted("completed"),
    ]);

    const completed = filterByTag(events, "item.completed");
    expect(completed[0]).toMatchObject({
      itemId: "w",
      kind: "wait",
      status: "failed",
      turnId: TURN,
    });
    expect(completed.filter((event) => event.kind === "unknown")).toHaveLength(1);
    expect(listEventTags(events).at(-1)).toBe("turn.completed");
    encodeAll(events);
  });

  it("is what an item type added by a newer Codex becomes", () => {
    const reports: Array<string> = [];

    const events = normalizeNotes(buildReportingState(reports), [
      buildItemCompleted({ type: "somethingCodexGrew", id: "i20" }),
    ]);

    expect(filterByTag(events, "item.completed")[0]).toMatchObject({
      kind: "unknown",
      detail: { label: "codex: item/somethingCodexGrew" },
    });
    expect(reports).toEqual(["codex: item/somethingCodexGrew"]);
  });

  it("still throws for an unreadable usage report, which the adapter recovers from", () => {
    const state = buildTestState();

    expect(() =>
      normalize(
        state,
        buildNote("thread/tokenUsage/updated", { threadId: THREAD, tokenUsage: {} }),
      ),
    ).toThrow();
  });
});

describe("a frame of a turn that is over", () => {
  const TURN_2 = "turn_2";
  const START_TURN_2 = buildNote("turn/started", {
    threadId: THREAD,
    turn: { ...buildTurn("inProgress"), id: TURN_2 },
  });
  const buildAnswer = (turnId: string, text: string): Note =>
    buildNote("item/completed", {
      item: { ...MESSAGE, id: `answer_${turnId}`, text },
      threadId: THREAD,
      turnId,
      completedAtMs: 1,
    });

  it("starts no item, and tells the log", () => {
    const ignored: Array<string> = [];
    const state = buildReportingState([], ignored);

    const events = normalizeNotes(state, [
      TURN_STARTED,
      START_TURN_2,
      buildNote("item/started", {
        item: { type: "sleep", id: "s_0", durationMs: 5 },
        threadId: THREAD,
        turnId: TURN,
        startedAtMs: 1,
      }),
    ]);

    expect(listEventTags(events)).toEqual(["turn.started", "turn.started"]);
    expect(ignored).toEqual(["late item/started"]);
  });

  it("streams no delta, and does not mark its message as streamed", () => {
    const ignored: Array<string> = [];
    const state = buildReportingState([], ignored);

    const late = normalizeNotes(state, [
      TURN_STARTED,
      START_TURN_2,
      buildDeltaNote("item/agentMessage/delta", { delta: "late" }),
    ]);
    const current = normalizeNotes(state, [
      buildNote("item/agentMessage/delta", {
        threadId: THREAD,
        turnId: TURN_2,
        itemId: "answer_turn_2",
        delta: "now",
      }),
    ]);

    expect(listEventTags(late)).toEqual(["turn.started", "turn.started"]);
    expect(ignored).toEqual(["late item/agentMessage/delta"]);
    expect(listStreamedDeltas(current)).toEqual([["assistant_text", "now"]]);
  });

  it("completes its item but does not replace the running turn's answer", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["result"],
      properties: { result: { type: "string" } },
    } as const;
    const state = buildNormalizingState(SESSION, THREAD, schema, IGNORE_REPORT);

    const events = normalizeNotes(state, [
      TURN_STARTED,
      START_TURN_2,
      buildAnswer(TURN_2, '{"result":"right"}'),
      buildAnswer(TURN, "late prose"),
      buildNote("turn/completed", {
        threadId: THREAD,
        turn: { ...buildTurn("completed"), id: TURN_2 },
      }),
    ]);

    expect(filterByTag(events, "item.completed").map((event) => event.turnId)).toEqual([
      TURN_2,
      TURN,
    ]);
    expect(filterByTag(events, "turn.completed")[0]).toMatchObject({
      structuredResult: { outcome: "ok", value: { result: "right" } },
    });
  });
});

describe("a frame of a turn that has already ended", () => {
  const SLEEP = { type: "sleep", id: "s_0", durationMs: 5 };

  it("starts no item and streams no delta, and still completes an item started before", () => {
    const ignored: Array<string> = [];
    const state = buildReportingState([], ignored);
    normalizeNotes(state, [
      TURN_STARTED,
      buildNote("item/started", { item: SLEEP, threadId: THREAD, turnId: TURN, startedAtMs: 1 }),
      buildTurnCompleted("completed"),
    ]);

    const late = normalizeNotes(state, [
      buildNote("item/started", {
        item: { ...SLEEP, id: "s_1" },
        threadId: THREAD,
        turnId: TURN,
        startedAtMs: 2,
      }),
      buildDeltaNote("item/agentMessage/delta", { delta: "late" }),
      buildItemCompleted(SLEEP),
    ]);

    expect(listEventTags(late)).toEqual(["item.completed"]);
    expect(filterByTag(late, "item.completed")[0]).toMatchObject({ itemId: "s_0", kind: "wait" });
    expect(ignored).toEqual(["late item/started", "late item/agentMessage/delta"]);
  });
});

describe("a completed message whose text cannot be read", () => {
  it("leaves no trace, so the same message completed again still gives its text", () => {
    const events = normalizeFromStart([
      TURN_STARTED,
      buildItemCompleted({ ...MESSAGE, text: 42 }),
      ITEM_COMPLETED,
    ]);

    // The unreadable completion closes its row as failed, then shows as a
    // fallback item; the good repeat completes normally and gives its text.
    expect(filterByTag(events, "item.completed").map((event) => event.kind)).toEqual([
      "assistant_message",
      "unknown",
      "assistant_message",
    ]);
    expect(listStreamedDeltas(events)).toEqual([["assistant_text", "Hello"]]);
    encodeAll(events);
  });
});

describe("a delta that cannot be read", () => {
  it("is reported as unknown, and leaves the message's text to its completion", () => {
    const events = normalizeFromStart([
      TURN_STARTED,
      buildDeltaNote("item/agentMessage/delta", { delta: 42 }),
      ITEM_COMPLETED,
    ]);

    expect(filterByTag(events, "item.completed").map((event) => event.kind)).toEqual([
      "unknown",
      "assistant_message",
    ]);
    expect(listStreamedDeltas(events)).toEqual([["assistant_text", "Hello"]]);
    encodeAll(events);
  });
});

describe("a plan with too many steps", () => {
  it("warns once for the turn, however often Codex sends it", () => {
    const long = Array.from({ length: 129 }, (_, index) => ({
      step: `Step ${index}`,
      status: "pending",
    }));

    const events = normalizeFromStart([
      TURN_STARTED,
      buildPlanNote(long),
      buildPlanNote(long),
      buildPlanNote(long),
    ]);

    expect(filterByTag(events, "runtime.warning")).toHaveLength(1);
  });
});
