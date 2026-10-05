/**
 * Tests for the Codex normalizer, which takes one decoded app-server
 * notification and a per-session state, and returns normalized events.
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
import type { ProviderEvent } from "@hercule/protocol";
import { normalize, buildNormalizingState } from "./normalize";

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

const buildTestState = () => buildNormalizingState(SESSION, THREAD, undefined);

const normalizeNotes = (
  running: ReturnType<typeof buildNormalizingState>,
  notes: ReadonlyArray<Note>,
): ReadonlyArray<ProviderEvent> => notes.flatMap((frame) => normalize(running, frame));

/** Normalizes a sequence of notifications against a fresh state, which is the common case. */
const normalizeFromStart = (notes: ReadonlyArray<Note>): ReadonlyArray<ProviderEvent> =>
  normalizeNotes(buildTestState(), notes);

const listEventTags = (events: ReadonlyArray<ProviderEvent>): ReadonlyArray<string> =>
  events.map((event) => event._tag);

const filterByTag = <Tag extends ProviderEvent["_tag"]>(
  events: ReadonlyArray<ProviderEvent>,
  tag: Tag,
): ReadonlyArray<Extract<ProviderEvent, { _tag: Tag }>> =>
  events.filter((event): event is Extract<ProviderEvent, { _tag: Tag }> => event._tag === tag);

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
      expect(event.providerRefs?.["threadId"]).toBe(THREAD);
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
  [{ type: "hookPrompt", id: "i14", fragments: [] }, "unknown"],
  [{ type: "imageView", id: "i15", path: "/tmp/a.png" }, "unknown"],
  [{ type: "sleep", id: "i16", durationMs: 10 }, "unknown"],
  [{ type: "imageGeneration", id: "i17" }, "unknown"],
  [{ type: "enteredReviewMode", id: "i18", review: "r" }, "unknown"],
  [{ type: "exitedReviewMode", id: "i19", review: "r" }, "unknown"],
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
  events: ReadonlyArray<ProviderEvent>,
): ReadonlyArray<readonly [string, string]> =>
  filterByTag(events, "content.delta").map((event) => [event.streamKind, event.delta] as const);

describe("which reasoning channel a session streams", () => {
  it("streams the summary when the summary is all Codex sends", () => {
    const events = normalizeFromStart([
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

    const first = normalizeNotes(running, [buildRawDelta("Because ")]);
    const second = normalizeNotes(running, [buildSummaryDelta("Weighing the options")]);

    expect(listStreamedDeltas(first)).toEqual([["reasoning_text", "Because "]]);
    // The summary repeats the same reasoning: emitting both would double the
    // item's text, and there is no separate stream kind for summaries.
    expect(listStreamedDeltas(second)).toEqual([]);
  });

  it("switches to raw when raw follows a summary, and drops the summary after it", () => {
    const running = buildTestState();

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
      buildDeltaNote("item/agentMessage/delta", { delta: "Hello" }),
    ]);
    const output = normalizeFromStart([
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

  it("counts a forked thread from its parent's total, with no restored report", () => {
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

const readItemDetail = (events: ReadonlyArray<ProviderEvent>): unknown =>
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
    // The row shows the first path; the full list is for a reader who opens the item.
    expect(readItemDetail(many)).toEqual({
      path: "/tmp/work/a.ts",
      paths: ["/tmp/work/a.ts", "/tmp/work/b.ts"],
    });
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
      { type: "plan", id: "i12", text: "1. look" },
      { type: "agentMessage", id: "i13", text: "hi" },
      { type: "reasoning", id: "i14", summary: [], content: [] },
      { type: "contextCompaction", id: "i15" },
      { type: "somethingCodexGrew", id: "i16" },
    ]) {
      expect(
        readItemDetail(normalizeFromStart([buildItemCompleted(item)])),
        item.type,
      ).toBeUndefined();
    }
  });

  it("includes the same detail on item.started as on item.completed", () => {
    const opened = normalizeFromStart([
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
