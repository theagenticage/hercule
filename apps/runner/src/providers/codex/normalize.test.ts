/**
 * The Codex normalizer: one decoded app-server notification plus a per-session
 * running state in, normalized events out. Nothing here starts a process.
 *
 * The frames are trimmed from the generated types of codex 0.154.0 under
 * `generated/v2/` - `TurnStartedNotification`, `ItemCompletedNotification`,
 * `ThreadItem`, the four delta notifications, `ThreadTokenUsageUpdatedNotification`
 * and `ErrorNotification` - keeping the fields a normalizer could read and
 * dropping the rest, never reshaping one.
 *
 * Assumed surface, because the module is the implementer's to name: the two
 * exports mirror `claude-code-normalize.ts`, `buildNormalizingState(sessionId, threadId)`
 * builds the running state and `normalize(state, notification)` takes one
 * decoded `{ method, params }` frame off the wire. Event ids and the `at`
 * instant are the module's own business and nothing below reads them. Rename
 * either export and these tests follow.
 */
import { describe, expect, it } from "vitest";
import type { ProviderEvent } from "@hercule/protocol";
import { normalize, buildNormalizingState } from "./normalize";

const SESSION = "0199e0e7-0000-7000-8000-0000000000ff";
const THREAD = "0199e0e7-0000-7000-8000-0000000000fe";
const TURN = "0199e0e7-0000-7000-8000-0000000000fd";
const ITEM = "item_0";

/** The one channel every raw payload from this adapter is filed under. */
const SOURCE = "codex.app-server.notification";

/** A frame as the codec hands it over: the method, and the params verbatim. */
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

/** A whole sequence against a state of its own, which is the common case. */
const normalizeFromStart = (notes: ReadonlyArray<Note>): ReadonlyArray<ProviderEvent> =>
  normalizeNotes(buildTestState(), notes);

const listEventTags = (events: ReadonlyArray<ProviderEvent>): ReadonlyArray<string> =>
  events.map((event) => event._tag);

const filterByTag = <Tag extends ProviderEvent["_tag"]>(
  events: ReadonlyArray<ProviderEvent>,
  tag: Tag,
): ReadonlyArray<Extract<ProviderEvent, { _tag: Tag }>> =>
  events.filter((event): event is Extract<ProviderEvent, { _tag: Tag }> => event._tag === tag);

/** A turn as `Turn` shapes it, trimmed to what a normalizer could read. */
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

  it("files every event under the app-server channel and names the native thread", () => {
    const events = normalizeFromStart([
      TURN_STARTED,
      ITEM_STARTED,
      buildDeltaNote("item/agentMessage/delta", { delta: "Hel" }),
      ITEM_COMPLETED,
      buildTurnCompleted("completed"),
    ]);

    expect(events).not.toEqual([]);
    for (const event of events) {
      // Without the thread id nothing joins the event to the native thread.
      expect(event.providerRefs?.["threadId"]).toBe(THREAD);
      // A delta carries no copy of its own frame: a turn is thousands of them,
      // and the payload is the delta the event already holds. Everything else
      // says whose payload it is holding.
      expect(event.raw?.source).toBe(event._tag === "content.delta" ? undefined : SOURCE);
    }
  });

  it("carries each way a turn can end into the state the taxonomy names", () => {
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

  it("says nothing about a turn that is still running", () => {
    // `inProgress` is a status the notification may carry; a turn that has not
    // ended is not a boundary, and reporting one would close it downstream.
    const events = normalizeFromStart([TURN_STARTED, buildTurnCompleted("inProgress")]);

    expect(filterByTag(events, "turn.completed")).toEqual([]);
  });
});

/**
 * One `ThreadItem` per union member, trimmed, with the kind it maps to - or
 * `null` where it is reported as nothing at all.
 */
const ITEMS: ReadonlyArray<readonly [Record<string, unknown>, string | null]> = [
  // `userMessage` is Codex echoing back what Hercule sent. The adapter reports
  // that input itself, with whether it steered - which an echo cannot say - so
  // the echo is dropped rather than reported as a second item.
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
  // Not a member of the union at 0.154.0: the forward-compatible case.
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
  it("maps every item type this release has, and calls the rest unknown", () => {
    for (const [item, kind] of ITEMS) {
      const events = normalizeFromStart([buildItemCompleted(item)]);

      expect(
        filterByTag(events, "item.completed").map((event) => event.kind),
        item["type"] as string,
      ).toEqual(kind === null ? [] : [kind]);
    }
  });

  it("keeps the payload of an item it has no kind for, so nothing is lost", () => {
    const item = { type: "somethingCodexGrew", id: "i20", note: "kept" };

    const events = normalizeFromStart([buildItemCompleted(item)]);

    const reported = filterByTag(events, "item.completed")[0];
    expect(reported?.kind).toBe("unknown");
    expect(reported?.raw).toMatchObject({ source: SOURCE });
    expect(JSON.stringify(reported?.raw?.payload)).toContain("somethingCodexGrew");
  });

  it("reports a command and a patch the user refused as declined, not as failed", () => {
    // A declined item is the user's answer, and a surface that read it as a
    // failure would show the agent as broken rather than as refused.
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

  it("streams raw reasoning only, once raw came first", () => {
    const running = buildTestState();

    const first = normalizeNotes(running, [buildRawDelta("Because ")]);
    const second = normalizeNotes(running, [buildSummaryDelta("Weighing the options")]);

    expect(listStreamedDeltas(first)).toEqual([["reasoning_text", "Because "]]);
    // The summary is the same thinking said twice: emitting both would double
    // the item's text, and there is no third stream kind to put it on.
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

  it("streams an assistant message as text and a command's output", () => {
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

const USAGE = buildNote("thread/tokenUsage/updated", {
  threadId: THREAD,
  turnId: TURN,
  tokenUsage: {
    total: buildTokenBreakdown(1200, 800, 340),
    last: buildTokenBreakdown(100, 40, 12),
    modelContextWindow: 272000,
  },
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

describe("what a session reports about its usage and its failures", () => {
  it("reports the running total, not what the last turn cost", () => {
    const events = normalizeFromStart([USAGE]);

    // `last` is one turn's; the taxonomy's snapshot is cumulative, and
    // reporting `last` would make the session look like it never grew.
    expect(filterByTag(events, "session.usage.updated")[0]?.usage).toMatchObject({
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 800,
    });
  });

  it("names the error class Codex named, whichever shape it named it in", () => {
    const string = normalizeFromStart([buildErrorNote("usageLimitExceeded")]);
    const object = normalizeFromStart([
      buildErrorNote({ httpConnectionFailed: { httpStatusCode: 503 } }),
    ]);
    const absent = normalizeFromStart([buildErrorNote(null)]);

    expect(filterByTag(string, "runtime.error")[0]?.class).toBe("usageLimitExceeded");
    expect(filterByTag(object, "runtime.error")[0]?.class).toBe("httpConnectionFailed");
    // An error with no class is still an error: reporting nothing would lose it.
    expect(filterByTag(absent, "runtime.error")[0]?.class).toBe("unknown");
  });

  it("warns rather than fails when Codex says it is retrying by itself", () => {
    const events = normalizeFromStart([buildErrorNote("serverOverloaded", { willRetry: true })]);

    expect(listEventTags(events)).toEqual(["runtime.warning"]);
    expect(filterByTag(events, "runtime.warning")[0]?.message).not.toBe("");
  });
});

const readItemDetail = (events: ReadonlyArray<ProviderEvent>): unknown =>
  filterByTag(events, "item.completed")[0]?.detail;

describe("what a surface reads off an item without opening it", () => {
  it("names the command a shell item ran and the path a patch touched", () => {
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
    // The first path is the row; the rest are there for a reader who opens it.
    expect(readItemDetail(many)).toEqual({
      path: "/tmp/work/a.ts",
      paths: ["/tmp/work/a.ts", "/tmp/work/b.ts"],
    });
  });

  it("names the tool a call reached for, and says whose tool it was", () => {
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

  it("names what a search looked for and which collab tool a subagent used", () => {
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

  it("says nothing about an item whose own text is the whole of it", () => {
    // A row for a plan or an assistant message reads the item's text, and a
    // detail repeating it would be a second copy to keep in step.
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

  it("reports an item Codex opens with the same detail it closes it with", () => {
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
