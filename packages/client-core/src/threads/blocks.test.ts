/**
 * Tests `buildThreadBlocks(rows, agent)`, which turns a thread's transcript
 * into the flat list of blocks the desktop draws, and
 * `appendSendingMessages(blocks, sending)`, which adds the messages on their
 * way into the session.
 *
 * The fixtures follow the adapters' real shapes: a user message is an
 * `item.started` and an `item.completed` with the same time and
 * `detail: { text }`, and an assistant message's text arrives only in
 * `content.delta` rows. Times are seconds after 09:00.
 */
import { describe, expect, it } from "vitest";
import type { Input, OpenRequest, Session, Subagent, TranscriptRow } from "@hercule/contract";
import { buildSessionAgentState, buildSubagentAgentState } from "./agent-state";
import { appendSendingMessages, buildThreadBlocks, type ThreadBlock } from "./blocks";
import { buildWorkRows } from "./work-rows";

type ProviderEvent = TranscriptRow["event"];
type ItemKind = Extract<ProviderEvent, { _tag: "item.started" }>["kind"];

const START = Date.parse("2026-09-30T09:00:00.000Z");

/** Returns the instant `seconds` after 09:00. */
const buildInstant = (seconds: number): string => new Date(START + seconds * 1000).toISOString();

let position = 0;

/** Wraps an event in a transcript row at the next position. */
const buildRow = (event: ProviderEvent): TranscriptRow => ({
  position: ++position,
  at: event.at,
  event,
});

/** Returns the fields every event carries, for an event at `seconds`. */
const buildEnvelope = (seconds: number) => ({
  eventId: `e${position}`,
  sessionId: "s1",
  at: buildInstant(seconds),
});

const buildTurnStarted = (turnId: string, seconds: number, model?: string): TranscriptRow =>
  buildRow({
    _tag: "turn.started",
    ...buildEnvelope(seconds),
    turnId,
    ...(model === undefined ? {} : { model }),
  });

const buildTurnCompleted = (
  turnId: string,
  seconds: number,
  state: "completed" | "failed" | "interrupted" = "completed",
): TranscriptRow => buildRow({ _tag: "turn.completed", ...buildEnvelope(seconds), turnId, state });

/** Returns the two rows of a user message, as the runner writes them. */
const buildUserMessage = (
  turnId: string,
  itemId: string,
  seconds: number,
  text: string,
  steered = false,
): TranscriptRow[] => {
  const detail = { text, ...(steered ? { steered: true } : {}) };
  return [
    buildRow({
      _tag: "item.started",
      ...buildEnvelope(seconds),
      turnId,
      itemId,
      kind: "user_message",
      detail,
    }),
    buildRow({
      _tag: "item.completed",
      ...buildEnvelope(seconds),
      turnId,
      itemId,
      kind: "user_message",
      status: "completed",
      detail,
    }),
  ];
};

const buildItemStarted = (
  turnId: string,
  itemId: string,
  kind: ItemKind,
  seconds: number,
  detail?: unknown,
): TranscriptRow =>
  buildRow({
    _tag: "item.started",
    ...buildEnvelope(seconds),
    turnId,
    itemId,
    kind,
    ...(detail === undefined ? {} : { detail: detail as never }),
  });

const buildItemCompleted = (
  turnId: string,
  itemId: string,
  kind: ItemKind,
  seconds: number,
  status: "completed" | "failed" | "declined" = "completed",
  detail?: unknown,
): TranscriptRow =>
  buildRow({
    _tag: "item.completed",
    ...buildEnvelope(seconds),
    turnId,
    itemId,
    kind,
    status,
    ...(detail === undefined ? {} : { detail: detail as never }),
  });

/** Returns an `item.updated` row, which replaces the detail of an item that started. */
const buildItemUpdated = (
  turnId: string,
  itemId: string,
  kind: ItemKind,
  seconds: number,
  detail?: unknown,
): TranscriptRow =>
  buildRow({
    _tag: "item.updated",
    ...buildEnvelope(seconds),
    turnId,
    itemId,
    kind,
    ...(detail === undefined ? {} : { detail: detail as never }),
  });

const buildText = (turnId: string, itemId: string, seconds: number, delta: string): TranscriptRow =>
  buildRow({
    _tag: "content.delta",
    ...buildEnvelope(seconds),
    turnId,
    itemId,
    streamKind: "assistant_text",
    delta,
  });

/** Returns the rows of a whole assistant message: its start, its text, and its end. */
const buildAgentMessage = (
  turnId: string,
  itemId: string,
  seconds: number,
  text: string,
): TranscriptRow[] => [
  buildItemStarted(turnId, itemId, "assistant_message", seconds),
  buildText(turnId, itemId, seconds, text),
  buildItemCompleted(turnId, itemId, "assistant_message", seconds + 1),
];

/** Returns the rows of a whole command: its start and its end. */
const buildCommand = (
  turnId: string,
  itemId: string,
  seconds: number,
  endSeconds: number,
): TranscriptRow[] => [
  buildItemStarted(turnId, itemId, "command_execution", seconds, {
    name: "Bash",
    input: { command: "ls" },
  }),
  buildItemCompleted(turnId, itemId, "command_execution", endSeconds),
];

/** Returns a `runtime.warning` row, in turn `turnId` or, when it is undefined, between turns. */
const buildWarning = (
  seconds: number,
  turnId: string | undefined,
  message: string,
): TranscriptRow =>
  buildRow({
    _tag: "runtime.warning",
    ...buildEnvelope(seconds),
    ...(turnId === undefined ? {} : { turnId }),
    message,
  });

/** Returns a `runtime.notice` row, in turn `turnId` or, when it is undefined, between turns. */
const buildRuntimeNotice = (
  seconds: number,
  turnId: string | undefined,
  message: string,
): TranscriptRow =>
  buildRow({
    _tag: "runtime.notice",
    ...buildEnvelope(seconds),
    ...(turnId === undefined ? {} : { turnId }),
    message,
  });

/** Returns a `runtime.error` row, in turn `turnId` or, when it is undefined, outside any turn. */
const buildError = (
  seconds: number,
  turnId: string | undefined,
  errorClass: string,
  message?: string,
): TranscriptRow =>
  buildRow({
    _tag: "runtime.error",
    ...buildEnvelope(seconds),
    ...(turnId === undefined ? {} : { turnId }),
    class: errorClass,
    ...(message === undefined ? {} : { message }),
  });

const REQUEST: OpenRequest = {
  requestId: "r1",
  itemId: "c1",
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command: "rm -rf build" },
};

const buildRequestOpened = (seconds: number, request: OpenRequest = REQUEST): TranscriptRow =>
  buildRow({ _tag: "request.opened", ...buildEnvelope(seconds), request });

const BASE: Session = {
  id: "s1",
  title: "Fix the login bug",
  kind: "thread",
  role: null,
  status: "idle",
  resumable: false,
  resumeHeld: false,
  toolCalls: 0,
  permissionProfileId: "profile-unrestricted",
  agentId: null,
  conversationId: null,
  runId: null,
  stepId: null,
  instanceId: "instance-claude-code",
  runnerId: "runner-1",
  workspaceId: null,
  projectId: null,
  requestedAccessMode: "approval-required",
  accessMode: "approval-required",
  nativeSessionId: null,
  modelSelection: { model: "claude-sonnet-5", options: {} },
  parentSessionId: null,
  openRequests: [],
  openPermissionRequests: [],
  createdAt: "2026-09-30T08:59:00.000Z",
  startedAt: "2026-09-30T08:59:01.000Z",
  exitedAt: null,
  lastActivityAt: "2026-09-30T09:00:00.000Z",
  unenforced: [],
};

const IDLE = BASE;
const BUSY: Session = { ...BASE, status: "busy" };

const listKeys = (blocks: readonly ThreadBlock[]): readonly string[] =>
  blocks.map((block) => block.key);

/** Returns the block with `key`, failing the test when there is none. */
const findBlock = <K extends ThreadBlock["kind"]>(
  blocks: readonly ThreadBlock[],
  kind: K,
  key: string,
): Extract<ThreadBlock, { kind: K }> => {
  const found = blocks.find((block) => block.key === key);
  if (found?.kind !== kind) throw new Error(`no ${kind} block with key ${key}`);
  return found as Extract<ThreadBlock, { kind: K }>;
};

describe("buildThreadBlocks", () => {
  it("draws a turn without tools as the user's message and the agent's answer", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Say hi"),
      ...buildAgentMessage("t1", "a1", 2, "Hi there."),
      buildTurnCompleted("t1", 3),
    ];

    expect(buildThreadBlocks(rows, buildSessionAgentState(IDLE))).toEqual([
      {
        kind: "user",
        key: "user:u1",
        itemId: "u1",
        text: "Say hi",
        attachments: [],
        skills: [],
        steered: false,
        at: buildInstant(0),
      },
      {
        kind: "agent",
        key: "agent:a1",
        itemId: "a1",
        turnId: "t1",
        text: "Hi there.",
        startedAt: buildInstant(2),
        model: "claude-sonnet-5",
        open: false,
        live: false,
      },
    ]);
  });

  it("carries the images a user message lists, and skips an entry that is not an image reference", () => {
    const screenshot = {
      id: "01920000-0000-7000-8000-000000000001",
      name: "error.png",
      mimeType: "image/png",
      sizeBytes: 2048,
    };
    const rows = [
      buildTurnStarted("t1", 0),
      buildRow({
        _tag: "item.started",
        ...buildEnvelope(0),
        turnId: "t1",
        itemId: "u1",
        kind: "user_message",
        detail: { text: "", attachments: [screenshot, { id: "img-2" }] },
      }),
    ];

    expect(
      findBlock(buildThreadBlocks(rows, buildSessionAgentState(BUSY)), "user", "user:u1"),
    ).toMatchObject({
      text: "",
      attachments: [screenshot],
    });
  });

  it("carries the skills a user message lists, and none for a message that lists none", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      buildRow({
        _tag: "item.started",
        ...buildEnvelope(0),
        turnId: "t1",
        itemId: "u1",
        kind: "user_message",
        detail: { text: "$review it", skills: ["review", 7] },
      }),
      ...buildUserMessage("t1", "u2", 1, "plain"),
    ];

    const blocks = buildThreadBlocks(rows, buildSessionAgentState(BUSY));
    expect(findBlock(blocks, "user", "user:u1")).toMatchObject({ skills: ["review"] });
    expect(findBlock(blocks, "user", "user:u2")).toMatchObject({ skills: [] });
  });

  it("marks a message another session's agent steered in with its sender, and the owner's with none", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Fix the login bug"),
      buildRow({
        _tag: "item.started",
        ...buildEnvelope(1),
        turnId: "t1",
        itemId: "u2",
        kind: "user_message",
        detail: { text: "Rebase on main", steered: true, senderSessionId: "s-sender" },
      }),
    ];

    const blocks = buildThreadBlocks(rows, buildSessionAgentState(BUSY));

    expect(findBlock(blocks, "user", "user:u1")).not.toHaveProperty("senderSessionId");
    expect(findBlock(blocks, "user", "user:u1").steered).toBe(false);
    expect(findBlock(blocks, "user", "user:u2")).toMatchObject({
      text: "Rebase on main",
      steered: true,
      senderSessionId: "s-sender",
    });
  });

  it("gives each stretch of work between two messages a block of its own", () => {
    const rows = [
      buildTurnStarted("t1", 0, "gpt-5.5"),
      ...buildUserMessage("t1", "u1", 0, "Fix the login bug"),
      buildItemStarted("t1", "r1", "reasoning", 1),
      buildItemCompleted("t1", "r1", "reasoning", 2),
      ...buildCommand("t1", "c1", 2, 5),
      buildItemStarted("t1", "f1", "file_change", 5, {
        name: "Edit",
        input: { file_path: "a.ts" },
      }),
      buildItemCompleted("t1", "f1", "file_change", 6, "failed"),
      ...buildAgentMessage("t1", "a1", 10, "Found it."),
      ...buildCommand("t1", "c2", 12, 20),
      ...buildAgentMessage("t1", "a2", 30, "Fixed."),
      buildTurnCompleted("t1", 31),
    ];

    const blocks = buildThreadBlocks(rows, buildSessionAgentState(IDLE));

    expect(listKeys(blocks)).toEqual(["user:u1", "work:r1", "agent:a1", "work:c2", "agent:a2"]);
    const first = findBlock(blocks, "work", "work:r1");
    expect(first.startedAt).toBe(buildInstant(0));
    expect(first.endedAt).toBe(buildInstant(10));
    expect(first.items.map((item) => [item.kind, item.result])).toEqual([
      ["reasoning", "completed"],
      ["command_execution", "completed"],
      ["file_change", "failed"],
    ]);
    // The second stretch starts when the message before it completed.
    const second = findBlock(blocks, "work", "work:c2");
    expect(second.startedAt).toBe(buildInstant(11));
    expect(second.endedAt).toBe(buildInstant(30));
    expect(findBlock(blocks, "agent", "agent:a2").model).toBe("gpt-5.5");
  });

  it("places a message the user steered in where it was sent, and starts the next stretch there", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Fix the login bug"),
      ...buildCommand("t1", "c1", 1, 2),
      ...buildAgentMessage("t1", "a1", 3, "Looking."),
      ...buildUserMessage("t1", "u2", 5, "Also check the logout", true),
      ...buildCommand("t1", "c2", 6, 7),
      ...buildAgentMessage("t1", "a2", 8, "Both fixed."),
      buildTurnCompleted("t1", 9),
    ];

    const blocks = buildThreadBlocks(rows, buildSessionAgentState(IDLE));

    expect(listKeys(blocks)).toEqual([
      "user:u1",
      "work:c1",
      "agent:a1",
      "user:u2",
      "work:c2",
      "agent:a2",
    ]);
    expect(findBlock(blocks, "user", "user:u2").text).toBe("Also check the logout");
    expect(findBlock(blocks, "work", "work:c2").startedAt).toBe(buildInstant(5));
  });

  it("places a message by its start when a steered message lands between its start and its text", () => {
    // The controller holds a message's text until the message completes, so
    // the text row sits after the message the user steered in meanwhile.
    const opening = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Say hi"),
      buildItemStarted("t1", "a1", "assistant_message", 1),
      ...buildUserMessage("t1", "u2", 2, "In French", true),
    ];
    const closing = [
      buildText("t1", "a1", 1, "Hello there."),
      buildItemCompleted("t1", "a1", "assistant_message", 3),
    ];

    const writing = buildThreadBlocks(opening, buildSessionAgentState(BUSY));
    expect(listKeys(writing)).toEqual(["user:u1", "agent:a1", "user:u2"]);
    expect(findBlock(writing, "agent", "agent:a1")).toMatchObject({
      text: "",
      open: true,
      live: true,
    });

    const written = buildThreadBlocks([...opening, ...closing], buildSessionAgentState(BUSY));
    expect(findBlock(written, "agent", "agent:a1")).toMatchObject({
      text: "Hello there.",
      open: false,
      live: false,
    });
    // The agent has the steered message still to answer, so the working face
    // is on no message: a status line below it shows the agent is busy.
    expect(listKeys(written)).toEqual(["user:u1", "agent:a1", "user:u2", "pending"]);
  });

  it("shows a status line for a session that is starting before any row", () => {
    expect(buildThreadBlocks([], buildSessionAgentState({ ...BASE, status: "starting" }))).toEqual([
      { kind: "pending", key: "pending", since: null },
    ]);
    expect(buildThreadBlocks([], buildSessionAgentState(IDLE))).toEqual([]);
  });

  it("shows only the status line, timed from the user message, while a turn runs before its first item", () => {
    const rows = [buildTurnStarted("t1", 0, "gpt-5.5"), ...buildUserMessage("t1", "u1", 0, "Hi")];

    expect(buildThreadBlocks(rows, buildSessionAgentState(BUSY))).toEqual([
      expect.objectContaining({ key: "user:u1" }),
      { kind: "pending", key: "pending", since: buildInstant(0) },
    ]);
  });

  it("draws no work block for a stretch of reasoning alone, and lists the reasoning once a tool joins it", () => {
    const thinking = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Hi"),
      buildItemStarted("t1", "r1", "reasoning", 1),
    ];
    expect(listKeys(buildThreadBlocks(thinking, buildSessionAgentState(BUSY)))).toEqual([
      "user:u1",
      "pending",
    ]);

    const working = [...thinking, buildItemStarted("t1", "c1", "command_execution", 2)];
    const blocks = buildThreadBlocks(working, buildSessionAgentState(BUSY));
    expect(listKeys(blocks)).toEqual(["user:u1", "work:r1"]);
    const work = findBlock(blocks, "work", "work:r1");
    expect(work.items.map((item) => item.kind)).toEqual(["reasoning", "command_execution"]);
    expect(work.endedAt).toBeNull();
  });

  it("puts the working face on the message the agent is writing, and shows no status line", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Hi"),
      ...buildCommand("t1", "c1", 1, 2),
      buildItemStarted("t1", "a1", "assistant_message", 3),
      // A 4 KB cut: part of the text is stored while the message is open.
      buildText("t1", "a1", 3, "Hel"),
    ];

    const blocks = buildThreadBlocks(rows, buildSessionAgentState(BUSY));

    expect(listKeys(blocks)).toEqual(["user:u1", "work:c1", "agent:a1"]);
    expect(findBlock(blocks, "agent", "agent:a1")).toMatchObject({
      text: "Hel",
      open: true,
      live: true,
    });
    expect(findBlock(blocks, "work", "work:c1").endedAt).toBe(buildInstant(3));
  });

  it("marks only the latest unfinished message open, as only its text streams in the tail", () => {
    // The end of a1 never arrived, and a2 started after it.
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Hi"),
      buildItemStarted("t1", "a1", "assistant_message", 1),
      buildText("t1", "a1", 1, "Hel"),
      buildItemStarted("t1", "a2", "assistant_message", 2),
    ];

    const blocks = buildThreadBlocks(rows, buildSessionAgentState(BUSY));

    expect(findBlock(blocks, "agent", "agent:a1")).toMatchObject({
      text: "Hel",
      open: false,
      live: false,
    });
    expect(findBlock(blocks, "agent", "agent:a2")).toMatchObject({ open: true, live: true });
  });

  it("keeps the working face on the last message until the turn's end lands", () => {
    const answered = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Hi"),
      ...buildAgentMessage("t1", "a1", 1, "Hello."),
    ];

    const waiting = buildThreadBlocks(answered, buildSessionAgentState(BUSY));
    expect(listKeys(waiting)).toEqual(["user:u1", "agent:a1"]);
    expect(findBlock(waiting, "agent", "agent:a1")).toMatchObject({ open: false, live: true });

    const ended = buildThreadBlocks(
      [...answered, buildTurnCompleted("t1", 3)],
      buildSessionAgentState(IDLE),
    );
    expect(listKeys(ended)).toEqual(["user:u1", "agent:a1"]);
    expect(findBlock(ended, "agent", "agent:a1").live).toBe(false);
  });

  it("times the status line from the end of the last message, while the agent only reasons after it", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Hi"),
      ...buildAgentMessage("t1", "a1", 1, "Let me think."),
      buildItemStarted("t1", "r1", "reasoning", 5),
    ];

    const blocks = buildThreadBlocks(rows, buildSessionAgentState(BUSY));

    expect(blocks.at(-1)).toEqual({ kind: "pending", key: "pending", since: buildInstant(2) });
  });

  it("draws no agent block for a message the user stopped before its first word, and keeps the ending", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Hi"),
      buildItemStarted("t1", "a1", "assistant_message", 1),
      buildTurnCompleted("t1", 3, "interrupted"),
    ];

    const blocks = buildThreadBlocks(rows, buildSessionAgentState(IDLE));

    expect(listKeys(blocks)).toEqual(["user:u1", "ending:t1"]);
  });

  it("draws no agent block for a completed message with no text, and shows the status line in its place", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Hi"),
      buildItemStarted("t1", "a1", "assistant_message", 1),
      buildItemCompleted("t1", "a1", "assistant_message", 2),
    ];

    const blocks = buildThreadBlocks(rows, buildSessionAgentState(BUSY));

    // The empty message cannot hold the working face, so the status line does.
    expect(listKeys(blocks)).toEqual(["user:u1", "pending"]);
  });

  it("keeps an open message with no text yet, so its row can wait for the first word", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Hi"),
      buildItemStarted("t1", "a1", "assistant_message", 1),
    ];

    const blocks = buildThreadBlocks(rows, buildSessionAgentState(BUSY));

    expect(listKeys(blocks)).toEqual(["user:u1", "agent:a1"]);
    expect(findBlock(blocks, "agent", "agent:a1")).toMatchObject({
      text: "",
      open: true,
      live: true,
    });
  });

  it("keeps the status line when a new turn only reasons after an earlier turn ended on work", () => {
    // A subagent can wake into a turn of its own with no user message. The
    // earlier turn's finished stretch is then the last block, but it is not a
    // running divider, so nothing else shows that the agent is busy.
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Hi"),
      ...buildCommand("t1", "c1", 1, 2),
      buildTurnCompleted("t1", 3),
      buildTurnStarted("t2", 4),
      buildItemStarted("t2", "r1", "reasoning", 5),
    ];

    const blocks = buildThreadBlocks(rows, buildSessionAgentState(BUSY));

    expect(listKeys(blocks)).toEqual(["user:u1", "work:c1", "pending"]);
    expect(findBlock(blocks, "work", "work:c1").endedAt).not.toBeNull();
  });

  it("shows no status line when a tool starts after the last message, because the running divider shows the work", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Hi"),
      ...buildAgentMessage("t1", "a1", 1, "Let me look."),
      buildItemStarted("t1", "c1", "command_execution", 3),
    ];

    const blocks = buildThreadBlocks(rows, buildSessionAgentState(BUSY));

    expect(listKeys(blocks)).toEqual(["user:u1", "agent:a1", "work:c1"]);
    expect(findBlock(blocks, "agent", "agent:a1").live).toBe(false);
  });

  it("shows no status line when a warning follows the running work, because the divider above it still shows the work", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Hi"),
      buildItemStarted("t1", "c1", "command_execution", 1),
      buildWarning(2, "t1", "retrying after a 529"),
    ];

    const blocks = buildThreadBlocks(rows, buildSessionAgentState(BUSY));

    expect(blocks.map((block) => block.kind)).toEqual(["user", "work", "warning"]);
  });

  it("ends a stopped turn with its duration", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Hi"),
      buildItemStarted("t1", "c1", "command_execution", 1),
      buildTurnCompleted("t1", 4, "interrupted"),
    ];

    const blocks = buildThreadBlocks(rows, buildSessionAgentState(IDLE));

    expect(listKeys(blocks)).toEqual(["user:u1", "work:c1", "ending:t1"]);
    expect(findBlock(blocks, "ending", "ending:t1")).toEqual({
      kind: "ending",
      key: "ending:t1",
      turnId: "t1",
      endState: "interrupted",
      duration: 4000,
    });
    expect(findBlock(blocks, "work", "work:c1").endedAt).toBe(buildInstant(4));
  });

  it("ends a turn that failed before any tool ran", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Hi"),
      buildTurnCompleted("t1", 2, "failed"),
    ];

    expect(buildThreadBlocks(rows, buildSessionAgentState(IDLE))).toEqual([
      expect.objectContaining({ key: "user:u1" }),
      { kind: "ending", key: "ending:t1", turnId: "t1", endState: "failed", duration: 2000 },
    ]);
  });

  it("counts a turn's duration from its start when the user message came first", () => {
    // Codex and pi write the user message before the turn starts.
    const rows = [
      ...buildUserMessage("t1", "u1", 0, "Hi"),
      buildTurnStarted("t1", 1),
      buildTurnCompleted("t1", 5, "interrupted"),
    ];

    expect(
      findBlock(buildThreadBlocks(rows, buildSessionAgentState(IDLE)), "ending", "ending:t1")
        .duration,
    ).toBe(4000);
  });

  it("cuts a turn short where its session exited", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Hi"),
      buildItemStarted("t1", "c1", "command_execution", 1),
      buildRow({ _tag: "session.exited", ...buildEnvelope(7), reason: "crash" }),
    ];

    const blocks = buildThreadBlocks(rows, buildSessionAgentState({ ...BASE, status: "exited" }));

    expect(listKeys(blocks)).toEqual(["user:u1", "work:c1", "ending:t1"]);
    expect(findBlock(blocks, "ending", "ending:t1")).toMatchObject({
      endState: null,
      duration: null,
    });
    expect(findBlock(blocks, "work", "work:c1").endedAt).toBe(buildInstant(7));
  });

  it.each(["exited", "queued"] as const)(
    "cuts the last turn short at its last row when the session reads %s, with no harness to run it",
    (status) => {
      // A runner that is lost ends its sessions without an exit row.
      const rows = [
        buildTurnStarted("t1", 0),
        ...buildUserMessage("t1", "u1", 0, "Hi"),
        buildItemStarted("t1", "c1", "command_execution", 3),
      ];

      const blocks = buildThreadBlocks(rows, buildSessionAgentState({ ...BASE, status }));

      expect(listKeys(blocks)).toEqual(["user:u1", "work:c1", "ending:t1"]);
      expect(findBlock(blocks, "ending", "ending:t1").endState).toBeNull();
      expect(findBlock(blocks, "work", "work:c1").endedAt).toBe(buildInstant(3));
    },
  );

  it.each(["idle", "starting"] as const)(
    "keeps a turn running when the session, read as %s, was read before the turn started",
    (status) => {
      // The rows arrive over the stream at once; the session's new status
      // arrives in a read that comes after them.
      const rows = [
        buildRow({ _tag: "session.started", ...buildEnvelope(0) }),
        buildTurnStarted("t1", 0),
        ...buildUserMessage("t1", "u1", 0, "Hi"),
      ];

      expect(buildThreadBlocks(rows, buildSessionAgentState({ ...BASE, status }))).toEqual([
        expect.objectContaining({ key: "user:u1" }),
        { kind: "pending", key: "pending", since: buildInstant(0) },
      ]);
    },
  );

  it("cuts a turn short where a new harness started", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Hi"),
      buildItemStarted("t1", "c1", "command_execution", 1),
      buildRow({ _tag: "session.started", ...buildEnvelope(9) }),
    ];

    const blocks = buildThreadBlocks(rows, buildSessionAgentState({ ...BASE, status: "starting" }));

    expect(listKeys(blocks)).toEqual(["user:u1", "work:c1", "ending:t1"]);
    expect(findBlock(blocks, "work", "work:c1").endedAt).toBe(buildInstant(9));
  });

  it("cuts a turn short when the next turn starts without its end", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Hi"),
      buildItemStarted("t1", "c1", "command_execution", 1),
      buildTurnStarted("t2", 5),
      ...buildUserMessage("t2", "u2", 5, "Again"),
      ...buildAgentMessage("t2", "a2", 6, "Done."),
      buildTurnCompleted("t2", 8),
    ];

    expect(listKeys(buildThreadBlocks(rows, buildSessionAgentState(IDLE)))).toEqual([
      "user:u1",
      "work:c1",
      "ending:t1",
      "user:u2",
      "agent:a2",
    ]);
  });

  it("draws nothing for a turn that holds only a late item end, and completes the item where it started", () => {
    // Claude Code sends an interrupted tool's result after the turn ended, and
    // the runner opens a turn of its own for it.
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Hi"),
      buildItemStarted("t1", "c1", "command_execution", 1),
      buildTurnCompleted("t1", 3, "interrupted"),
      buildTurnStarted("t2", 4),
      buildItemCompleted("t2", "c1", "command_execution", 4, "failed"),
      buildTurnCompleted("t2", 4),
    ];

    const blocks = buildThreadBlocks(rows, buildSessionAgentState(IDLE));

    expect(listKeys(blocks)).toEqual(["user:u1", "work:c1", "ending:t1"]);
    expect(findBlock(blocks, "work", "work:c1").items[0]!.result).toBe("failed");
    expect(findBlock(blocks, "ending", "ending:t1").duration).toBe(3000);
  });

  it("draws no block for usage and session rows", () => {
    const rows = [
      buildRow({ _tag: "session.started", ...buildEnvelope(0) }),
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Hi"),
      buildRow({
        _tag: "session.usage.updated",
        ...buildEnvelope(1),
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
      ...buildAgentMessage("t1", "a1", 2, "Hello."),
      buildTurnCompleted("t1", 3),
    ];

    expect(listKeys(buildThreadBlocks(rows, buildSessionAgentState(IDLE)))).toEqual([
      "user:u1",
      "agent:a1",
    ]);
  });

  it("places each runtime warning where its row sits, without splitting the work stretch", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Fix it"),
      ...buildCommand("t1", "c1", 1, 2),
      buildWarning(3, "t1", "retrying after a 529"),
      ...buildCommand("t1", "c2", 4, 5),
      ...buildAgentMessage("t1", "a1", 6, "Done."),
      buildTurnCompleted("t1", 8),
      // Between turns, a warning names no turn.
      buildWarning(9, undefined, "the model was rerouted"),
      buildTurnStarted("t2", 10),
      ...buildUserMessage("t2", "u2", 10, "Thanks"),
    ];

    const blocks = buildThreadBlocks(rows, buildSessionAgentState(BUSY));

    expect(blocks.map((block) => (block.kind === "warning" ? block.message : block.key))).toEqual([
      "user:u1",
      "work:c1",
      "retrying after a 529",
      "agent:a1",
      "the model was rerouted",
      "user:u2",
      "pending",
    ]);
    const work = findBlock(blocks, "work", "work:c1");
    expect(work.items.map((item) => item.itemId)).toEqual(["c1", "c2"]);
    expect(work.endedAt).toBe(buildInstant(6));
    expect(blocks.find((block) => block.kind === "warning")).toMatchObject({
      at: buildInstant(3),
    });
  });

  it("places each runtime notice where its row sits, without splitting the work stretch", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Fix it"),
      ...buildCommand("t1", "c1", 1, 2),
      buildRuntimeNotice(3, "t1", "Recalled 2 memories"),
      ...buildCommand("t1", "c2", 4, 5),
      ...buildAgentMessage("t1", "a1", 6, "Done."),
      buildTurnCompleted("t1", 8),
      // Between turns, a runtime notice names no turn.
      buildRuntimeNotice(9, undefined, "Conversation was cleared"),
      buildTurnStarted("t2", 10),
      ...buildUserMessage("t2", "u2", 10, "Thanks"),
    ];

    const blocks = buildThreadBlocks(rows, buildSessionAgentState(BUSY));

    expect(
      blocks.map((block) => (block.kind === "runtime-notice" ? block.message : block.key)),
    ).toEqual([
      "user:u1",
      "work:c1",
      "Recalled 2 memories",
      "agent:a1",
      "Conversation was cleared",
      "user:u2",
      "pending",
    ]);
    expect(findBlock(blocks, "work", "work:c1").items.map((item) => item.itemId)).toEqual([
      "c1",
      "c2",
    ]);
    expect(blocks.find((block) => block.kind === "runtime-notice")).toMatchObject({
      kind: "runtime-notice",
      at: buildInstant(3),
    });
  });

  it("shows no status line when a runtime notice follows the running work, because the divider above it still shows the work", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Hi"),
      buildItemStarted("t1", "c1", "command_execution", 1),
      buildRuntimeNotice(2, "t1", "Recalled 1 memory"),
    ];

    const blocks = buildThreadBlocks(rows, buildSessionAgentState(BUSY));

    expect(blocks.map((block) => block.kind)).toEqual(["user", "work", "runtime-notice"]);
  });

  it("places a runtime error where its row sits, inside the work stretch and above the failed turn's ending", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Fix it"),
      ...buildCommand("t1", "c1", 1, 2),
      buildError(3, "t1", "ContextWindowExceeded", "The context window is full."),
      ...buildCommand("t1", "c2", 4, 5),
    ];
    const describeBlocks = (blocks: readonly ThreadBlock[]): readonly string[] =>
      blocks.map((block) => (block.kind === "error" ? block.message : block.key));

    // While the turn runs, the stretch's divider above the error shows the
    // agent is busy, so no status line is added under the error.
    expect(describeBlocks(buildThreadBlocks(rows, buildSessionAgentState(BUSY)))).toEqual([
      "user:u1",
      "work:c1",
      "The context window is full.",
    ]);

    const blocks = buildThreadBlocks(
      [...rows, buildTurnCompleted("t1", 6, "failed")],
      buildSessionAgentState(IDLE),
    );

    expect(describeBlocks(blocks)).toEqual([
      "user:u1",
      "work:c1",
      "The context window is full.",
      "ending:t1",
    ]);
    expect(findBlock(blocks, "work", "work:c1").items.map((item) => item.itemId)).toEqual([
      "c1",
      "c2",
    ]);
    expect(blocks.find((block) => block.kind === "error")).toMatchObject({ at: buildInstant(3) });
  });

  it("shows why a session failed to start as an error with the runner's text, or its class when it has none", () => {
    const rows = [
      buildError(
        0,
        undefined,
        "unknown",
        "Could not load skill `review`. The Thread did not start.",
      ),
      buildRow({ _tag: "session.exited", ...buildEnvelope(0), reason: "crash" }),
      buildError(1, undefined, "usageLimitExceeded"),
    ];

    const blocks = buildThreadBlocks(rows, buildSessionAgentState(IDLE));

    expect(blocks.map((block) => (block.kind === "error" ? block.message : block.key))).toEqual([
      "Could not load skill `review`. The Thread did not start.",
      "usageLimitExceeded",
    ]);
  });

  it("places the waiting block where its Request opened, and freezes the stretch there", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Clean up"),
      buildItemStarted("t1", "c1", "command_execution", 1, {
        name: "Bash",
        input: { command: "rm -rf build" },
      }),
      buildRequestOpened(3),
    ];

    const blocks = buildThreadBlocks(
      rows,
      buildSessionAgentState({ ...BUSY, openRequests: [REQUEST] }),
    );

    expect(listKeys(blocks)).toEqual(["user:u1", "work:c1", "waiting:r1"]);
    expect(findBlock(blocks, "waiting", "waiting:r1")).toEqual({
      kind: "waiting",
      key: "waiting:r1",
      requestId: "r1",
      openedAt: buildInstant(3),
    });
    const work = findBlock(blocks, "work", "work:c1");
    expect(work.endedAt).toBe(buildInstant(3));
    expect(work.items[0]!.result).toBe("awaiting approval");
  });

  it("draws a waiting block for each of the agent's open Requests, and no working face", () => {
    const second: OpenRequest = { ...REQUEST, requestId: "r2", itemId: "c2" };
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Clean up"),
      // Two tool calls of one model call start before the harness asks
      // about either.
      buildItemStarted("t1", "c1", "command_execution", 1),
      buildItemStarted("t1", "c2", "command_execution", 1),
      buildRequestOpened(2),
      buildRequestOpened(3, second),
    ];

    const blocks = buildThreadBlocks(
      rows,
      buildSessionAgentState({ ...BUSY, openRequests: [REQUEST, second] }),
    );

    expect(listKeys(blocks)).toEqual(["user:u1", "work:c1", "waiting:r1", "waiting:r2"]);
    expect(findBlock(blocks, "work", "work:c1").items.map((item) => item.result)).toEqual([
      "awaiting approval",
      "awaiting approval",
    ]);
  });

  it("treats an async question as no wait: no waiting block, no frozen stretch, the working face stays", () => {
    // The agent asks in its own message, then goes on with a command. The
    // question is the message's text, so the transcript shows it once.
    const asked: OpenRequest = {
      requestId: "q1",
      itemId: "a1",
      kind: "question",
      async: true,
      detail: {
        questions: [
          {
            question: "Which storage should drafts use?",
            header: "Question",
            options: [{ label: "localStorage" }],
            multiSelect: false,
          },
        ],
      },
    };
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Pick"),
      ...buildAgentMessage("t1", "a1", 1, "Which storage should drafts use?"),
      buildRequestOpened(2, asked),
      buildItemStarted("t1", "c1", "command_execution", 3),
    ];

    const blocks = buildThreadBlocks(
      rows,
      buildSessionAgentState({ ...BUSY, openRequests: [asked] }),
    );

    expect(listKeys(blocks)).toEqual(["user:u1", "agent:a1", "work:c1"]);
    const work = findBlock(blocks, "work", "work:c1");
    expect(work.endedAt).toBeNull();
    expect(work.items[0]!.result).toBe("running");
  });

  it("keeps the pending status line while an async question is open and the agent has drawn nothing", () => {
    const asked: OpenRequest = {
      requestId: "q1",
      itemId: "a1",
      kind: "question",
      async: true,
      detail: {
        questions: [{ question: "Ready?", header: "Question", options: [], multiSelect: false }],
      },
    };
    const rows = [buildTurnStarted("t1", 0), ...buildUserMessage("t1", "u1", 0, "Go")];

    const blocks = buildThreadBlocks(
      rows,
      buildSessionAgentState({ ...BUSY, openRequests: [asked] }),
    );

    expect(listKeys(blocks)).toEqual(["user:u1", "pending"]);
  });

  it("shows the working face of a running subagent before its first turn", () => {
    const subagent: Subagent = {
      id: "agent-1",
      sessionId: BUSY.id,
      status: "running",
      toolCalls: 0,
      startedAt: buildInstant(0),
    };

    expect(listKeys(buildThreadBlocks([], buildSubagentAgentState(subagent, IDLE)))).toEqual([
      "pending",
    ]);
    expect(
      buildThreadBlocks([], buildSubagentAgentState({ ...subagent, status: "completed" }, BUSY)),
    ).toEqual([]);
  });

  it("cuts a subagent's last turn short when the subagent was stopped, though its session runs again", () => {
    // The session exited mid-turn, which stopped the subagent, and then
    // resumed. The subagent's transcript holds no row of either.
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Look around"),
      buildItemStarted("t1", "c1", "command_execution", 2),
    ];
    const subagent: Subagent = {
      id: "agent-1",
      sessionId: IDLE.id,
      status: "stopped",
      toolCalls: 1,
      startedAt: buildInstant(0),
      endedAt: buildInstant(5),
    };

    const blocks = buildThreadBlocks(rows, buildSubagentAgentState(subagent, IDLE));

    expect(listKeys(blocks)).toEqual(["user:u1", "work:c1", "ending:t1"]);
    expect(findBlock(blocks, "ending", "ending:t1").endState).toBeNull();
  });

  it("draws no waiting block for a Request that was answered", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Clean up"),
      buildItemStarted("t1", "c1", "command_execution", 1),
      buildRequestOpened(3),
      buildRow({
        _tag: "request.resolved",
        ...buildEnvelope(5),
        requestId: "r1",
        decision: "allow",
      }),
    ];

    const blocks = buildThreadBlocks(rows, buildSessionAgentState(BUSY));

    expect(listKeys(blocks)).toEqual(["user:u1", "work:c1"]);
    const work = findBlock(blocks, "work", "work:c1");
    expect(work.endedAt).toBeNull();
    expect(work.items[0]!.result).toBe("running");
  });

  it("keeps each block's key as rows are appended", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Hi"),
      ...buildCommand("t1", "c1", 1, 2),
      ...buildAgentMessage("t1", "a1", 3, "Halfway."),
      ...buildCommand("t1", "c2", 5, 6),
      buildWarning(6, "t1", "retrying after a 529"),
      ...buildAgentMessage("t1", "a2", 7, "Done."),
      buildTurnCompleted("t1", 9, "interrupted"),
    ];
    const final = listKeys(buildThreadBlocks(rows, buildSessionAgentState(IDLE)));

    for (let length = 1; length < rows.length; length++) {
      const keys = listKeys(
        buildThreadBlocks(rows.slice(0, length), buildSessionAgentState(BUSY)),
      ).filter((key) => key !== "pending");
      expect(final.slice(0, keys.length)).toEqual(keys);
    }
  });

  it("reads the files a file change touched from each adapter's detail", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Edit"),
      buildItemStarted("t1", "claude", "file_change", 1, {
        name: "Edit",
        input: { file_path: "src/a.ts" },
      }),
      buildItemStarted("t1", "codex", "file_change", 1, {
        path: "src/b.ts",
        paths: ["src/b.ts", "src/c.ts"],
      }),
      buildItemStarted("t1", "pi", "file_change", 1, { path: "src/d.ts" }),
      buildItemStarted("t1", "bare", "file_change", 1),
      buildItemStarted("t1", "command", "command_execution", 1, { path: "src/e.ts" }),
    ];

    const work = findBlock(
      buildThreadBlocks(rows, buildSessionAgentState(BUSY)),
      "work",
      "work:claude",
    );

    expect(work.items.map((item) => item.paths)).toEqual([
      ["src/a.ts"],
      ["src/b.ts", "src/c.ts"],
      ["src/d.ts"],
      [],
      [],
    ]);
  });

  it("keeps when each tool item started, and the name of the tool only for a tool call", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Look"),
      buildItemStarted("t1", "fetch", "tool_call", 2, {
        name: "WebFetch",
        input: { url: "https://example.com" },
      }),
      buildItemStarted("t1", "read", "file_read", 3, {
        path: "/tmp/shot.png",
        name: "Read",
        input: { file_path: "/tmp/shot.png" },
      }),
      buildItemStarted("t1", "plan", "plan", 4),
    ];

    const work = findBlock(
      buildThreadBlocks(rows, buildSessionAgentState(BUSY)),
      "work",
      "work:fetch",
    );

    expect(work.items.map((item) => [item.startedAt, item.toolName])).toEqual([
      [buildInstant(2), "WebFetch"],
      [buildInstant(3), ""],
      [buildInstant(4), ""],
    ]);
  });

  it("reads a file read's and a file search's target and paths from their fixed fields only", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Look"),
      buildItemStarted("t1", "read", "file_read", 1, {
        path: "src/a.ts",
        name: "Read",
        input: { file_path: "src/other.ts" },
      }),
      buildItemStarted("t1", "grep", "file_search", 2, {
        pattern: "TODO",
        path: "src",
        name: "Grep",
      }),
      buildItemStarted("t1", "glob", "file_search", 3, { pattern: "**/*.ts", name: "Glob" }),
      buildItemStarted("t1", "ls", "file_search", 4, { path: "src", name: "LS" }),
    ];

    const work = findBlock(
      buildThreadBlocks(rows, buildSessionAgentState(BUSY)),
      "work",
      "work:read",
    );

    expect(work.items.map((item) => [item.target, item.targetIsCode, item.paths])).toEqual([
      ["src/a.ts", true, ["src/a.ts"]],
      ["TODO in src", true, []],
      ["**/*.ts", true, []],
      ["src", true, []],
    ]);
  });

  it("gives a tool call the target its input names, never its tool's name, and marks a command or path as code", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Look"),
      buildItemStarted("t1", "fetch", "tool_call", 1, {
        name: "WebFetch",
        input: { description: "Fetch the release notes\nand more" },
      }),
      buildItemStarted("t1", "todo", "tool_call", 2, { name: "TodoWrite", input: { todos: [] } }),
      buildItemStarted("t1", "exec", "tool_call", 3, {
        name: "mcp__tools__exec",
        input: { command: "git status" },
      }),
      buildItemStarted("t1", "open", "tool_call", 4, {
        name: "mcp__files__open",
        input: { file_path: "src/a.ts" },
      }),
    ];

    const work = findBlock(
      buildThreadBlocks(rows, buildSessionAgentState(BUSY)),
      "work",
      "work:fetch",
    );

    expect(work.items.map((item) => [item.target, item.targetIsCode])).toEqual([
      ["Fetch the release notes", false],
      ["", false],
      ["git status", true],
      ["src/a.ts", true],
    ]);
  });

  it("keeps each tool item's result content as its completion sent it", () => {
    const blocks = [{ type: "text", text: "first" }, null, { type: "image" }];
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Look"),
      buildItemStarted("t1", "text", "command_execution", 1),
      buildItemCompleted("t1", "text", "command_execution", 2, "completed", {
        content: "a.ts\nb.ts",
      }),
      buildItemStarted("t1", "blocks", "tool_call", 2),
      buildItemCompleted("t1", "blocks", "tool_call", 3, "completed", { content: blocks }),
      buildItemStarted("t1", "bare", "tool_call", 3),
      buildItemCompleted("t1", "bare", "tool_call", 4),
      buildItemStarted("t1", "running", "tool_call", 4),
    ];

    const work = findBlock(
      buildThreadBlocks(rows, buildSessionAgentState(BUSY)),
      "work",
      "work:text",
    );

    expect(work.items.map((item) => item.resultContent)).toEqual([
      "a.ts\nb.ts",
      blocks,
      undefined,
      undefined,
    ]);
    expect(work.items[1]!.resultContent).toBe(blocks);
  });

  it("keeps the result of an item that completes after its turn ended", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Look"),
      buildItemStarted("t1", "run", "command_execution", 1),
      buildTurnCompleted("t1", 2, "interrupted"),
      buildItemCompleted("t1", "run", "command_execution", 3, "failed", { content: "killed" }),
    ];

    const work = findBlock(
      buildThreadBlocks(rows, buildSessionAgentState(IDLE)),
      "work",
      "work:run",
    );

    expect(work.items[0]).toMatchObject({ result: "failed", resultContent: "killed" });
  });
});

describe("buildThreadBlocks: compaction and unknown steps, drawn as work rows", () => {
  /** Builds the work rows of the only stretch of a turn holding the item rows `itemRows`. */
  const buildRowsOf = (itemRows: readonly TranscriptRow[]) => {
    const blocks = buildThreadBlocks(
      [buildTurnStarted("t1", 0), ...buildUserMessage("t1", "u1", 0, "Hi"), ...itemRows],
      buildSessionAgentState(BUSY),
    );
    return buildWorkRows(blocks.flatMap((block) => (block.kind === "work" ? block.items : [])));
  };

  it("draws a compaction that completed with its counts and summary: the words and an openable summary", () => {
    const rows = buildRowsOf([
      buildItemStarted("t1", "k1", "context_compaction", 1),
      buildItemCompleted("t1", "k1", "context_compaction", 5, "completed", {
        trigger: "auto",
        tokensBefore: 182_000,
        tokensAfter: 31_000,
        summary: "The user asked for a login fix.",
      }),
    ]);

    expect(rows).toEqual([
      expect.objectContaining({
        icon: "compress",
        label: "Compacted the context",
        target: "182k → 31k tokens (auto)",
        targetIsCode: false,
        result: "completed",
        output: "The user asked for a login fix.",
        canOpen: true,
      }),
    ]);
  });

  it("draws a running compaction with no counts and nothing to open", () => {
    const rows = buildRowsOf([buildItemStarted("t1", "k1", "context_compaction", 1)]);

    expect(rows).toEqual([
      expect.objectContaining({
        label: "Compacted the context",
        target: "",
        result: "running",
        canOpen: false,
      }),
    ]);
  });

  it("keeps the counts a compaction started with when it fails with no detail", () => {
    const rows = buildRowsOf([
      buildItemStarted("t1", "k1", "context_compaction", 1, { tokensBefore: 182_000 }),
      buildItemCompleted("t1", "k1", "context_compaction", 5, "failed"),
    ]);

    expect(rows[0]).toMatchObject({ target: "from 182k tokens", result: "failed", canOpen: false });
  });

  it("merges what a compaction started with and what it completed with, the completion winning", () => {
    const rows = buildRowsOf([
      buildItemStarted("t1", "k1", "context_compaction", 1, {
        trigger: "auto",
        tokensBefore: 182_000,
        tokensAfter: 40_000,
      }),
      buildItemCompleted("t1", "k1", "context_compaction", 5, "completed", {
        tokensAfter: 31_000,
        summary: "The user asked for a login fix.",
      }),
    ]);

    expect(rows[0]).toMatchObject({
      target: "182k → 31k tokens (auto)",
      output: "The user asked for a login fix.",
    });
  });

  it("opens a compaction to the summary it started with when the completion has none", () => {
    const rows = buildRowsOf([
      buildItemStarted("t1", "k1", "context_compaction", 1, {
        trigger: "auto",
        tokensBefore: 182_000,
        summary: "the summary",
      }),
      buildItemCompleted("t1", "k1", "context_compaction", 5, "completed", { tokensAfter: 31_000 }),
    ]);

    expect(rows[0]).toMatchObject({
      target: "182k → 31k tokens (auto)",
      output: "the summary",
      canOpen: true,
    });
  });

  it("opens a failed compaction to the summary it started with, though its completion has no detail", () => {
    const rows = buildRowsOf([
      buildItemStarted("t1", "k1", "context_compaction", 1, { summary: "the summary" }),
      buildItemCompleted("t1", "k1", "context_compaction", 5, "failed"),
    ]);

    expect(rows[0]).toMatchObject({ output: "the summary", canOpen: true });
  });

  it("draws a compaction written with the old field names as the bare words, with no counts and no summary", () => {
    const rows = buildRowsOf([
      buildItemStarted("t1", "k1", "context_compaction", 1, { trigger: "auto" }),
      buildItemCompleted("t1", "k1", "context_compaction", 5, "completed", {
        trigger: "auto",
        preTokens: 182_000,
        postTokens: 31_000,
      }),
    ]);

    expect(rows).toEqual([
      expect.objectContaining({
        icon: "compress",
        label: "Compacted the context",
        target: "",
        canOpen: false,
      }),
    ]);
  });

  it("draws an unknown step by its label, and one with no detail as a bare Step", () => {
    const rows = buildRowsOf([
      buildItemStarted("t1", "x1", "unknown", 1, { label: "claude: system/foo_bar" }),
      buildItemCompleted("t1", "x1", "unknown", 1),
      buildItemStarted("t1", "x2", "unknown", 2),
      buildItemCompleted("t1", "x2", "unknown", 2),
    ]);

    expect(rows.map((row) => [row.icon, row.label, row.target])).toEqual([
      ["question", "claude: system/foo_bar", ""],
      ["more", "Step", ""],
    ]);
  });
});

describe("appendSendingMessages", () => {
  const SENDING: Input = {
    id: "01a1317e-d8d3-7402-8971-cfcc37f653ca",
    sessionId: "s1",
    source: "user",
    actor: "user",
    text: "please rebase the pr on main",
    attachments: [],
    status: "queued",
    delivery: null,
    createdAt: buildInstant(60),
    deliveredAt: null,
    sentAt: buildInstant(60),
    reason: null,
  };
  const SENT_BLOCK: ThreadBlock = {
    kind: "user",
    key: `sending:${SENDING.id}`,
    itemId: SENDING.id,
    text: "please rebase the pr on main",
    attachments: [],
    skills: [],
    steered: false,
    at: buildInstant(60),
    sending: true,
  };
  const EARLIER: ThreadBlock = {
    kind: "user",
    key: "user:u1",
    itemId: "u1",
    text: "Fix the typo.",
    attachments: [],
    skills: [],
    steered: false,
    at: buildInstant(0),
  };
  const PENDING: ThreadBlock = { kind: "pending", key: "pending", since: buildInstant(1) };

  it("adds a sending message after the transcript's blocks", () => {
    expect(appendSendingMessages([EARLIER], [SENDING])).toEqual([EARLIER, SENT_BLOCK]);
  });

  it("keeps the agent's closing status line last", () => {
    expect(appendSendingMessages([EARLIER, PENDING], [SENDING])).toEqual([
      EARLIER,
      SENT_BLOCK,
      PENDING,
    ]);
  });

  it("names the session whose agent sent the message", () => {
    const sender = "01a12f36-0000-7000-8000-0000000000aa";
    const fromAgent = { ...SENDING, actor: `session:${sender}` };
    expect(appendSendingMessages([EARLIER], [fromAgent])).toEqual([
      EARLIER,
      { ...SENT_BLOCK, senderSessionId: sender },
    ]);
  });

  it("returns the same list when nothing is sending", () => {
    const blocks = [EARLIER];
    expect(appendSendingMessages(blocks, [])).toBe(blocks);
  });
});

describe("buildThreadBlocks: todo lists, page fetches and MCP calls, drawn as work rows", () => {
  type Status = "pending" | "in_progress" | "completed";

  /** Returns the detail of a todo list whose steps are named "step 1", "step 2" and so on, with `statuses`. */
  const buildTodoDetail = (...statuses: readonly Status[]) => ({
    steps: statuses.map((status, index) => ({ text: `step ${index + 1}`, status })),
  });

  /** Builds the work rows of the stretches of a turn holding the item rows `itemRows`. */
  const buildRowsOf = (itemRows: readonly TranscriptRow[]) => {
    const blocks = buildThreadBlocks(
      [buildTurnStarted("t1", 0), ...buildUserMessage("t1", "u1", 0, "Hi"), ...itemRows],
      buildSessionAgentState(BUSY),
    );
    return buildWorkRows(blocks.flatMap((block) => (block.kind === "work" ? block.items : [])));
  };

  it("draws a list started and updated twice as one row whose count changes, and which is never running", () => {
    const started = buildItemStarted(
      "t1",
      "todo",
      "todo_list",
      1,
      buildTodoDetail("in_progress", "pending", "pending"),
    );
    const afterFirst = buildItemUpdated(
      "t1",
      "todo",
      "todo_list",
      2,
      buildTodoDetail("completed", "in_progress", "pending"),
    );
    const afterSecond = buildItemUpdated(
      "t1",
      "todo",
      "todo_list",
      3,
      buildTodoDetail("completed", "completed", "completed"),
    );

    const drawn = [started, afterFirst, afterSecond].map((_, index, all) =>
      buildRowsOf(all.slice(0, index + 1)),
    );

    expect(drawn.map((rows) => rows.map((row) => [row.icon, row.label, row.target]))).toEqual([
      [["tasks", "Tasks 0/3", "step 1"]],
      [["tasks", "Tasks 1/3", "step 2"]],
      [["tasks", "Tasks 3/3", ""]],
    ]);
    const [row] = drawn[1]!;
    expect(row).toMatchObject({
      key: "row:todo",
      targetIsCode: false,
      result: "completed",
      canOpen: true,
      todoSteps: [
        { text: "step 1", status: "completed" },
        { text: "step 2", status: "in_progress" },
        { text: "step 3", status: "pending" },
      ],
      steps: [],
    });
  });

  it("keeps the list when an update has no detail or one that does not decode", () => {
    const rows = buildRowsOf([
      buildItemStarted("t1", "todo", "todo_list", 1, buildTodoDetail("in_progress", "pending")),
      buildItemUpdated("t1", "todo", "todo_list", 2),
      buildItemUpdated("t1", "todo", "todo_list", 3, { steps: "everything" }),
    ]);

    expect(rows).toEqual([
      expect.objectContaining({ label: "Tasks 0/2", target: "step 1", canOpen: true }),
    ]);
    expect(rows[0]!.todoSteps).toHaveLength(2);
  });

  it("ignores an update for an item that never started, or that is a message", () => {
    const blocks = buildThreadBlocks(
      [
        buildTurnStarted("t1", 0),
        ...buildUserMessage("t1", "u1", 0, "Hi"),
        buildItemUpdated("t1", "ghost", "todo_list", 1, buildTodoDetail("pending")),
        buildItemUpdated("t1", "u1", "user_message", 1, { text: "changed" }),
        ...buildAgentMessage("t1", "a1", 2, "Done."),
        buildItemUpdated("t1", "a1", "assistant_message", 4, { text: "changed" }),
      ],
      buildSessionAgentState(BUSY),
    );

    expect(blocks.map((block) => block.kind)).toEqual(["user", "agent"]);
    expect(blocks.map((block) => (block.kind === "agent" ? block.text : ""))).toEqual([
      "",
      "Done.",
    ]);
  });

  it("keeps a todo list's own result: a failed list stays failed, and a finished one is completed", () => {
    const failed = buildRowsOf([
      buildItemStarted("t1", "todo", "todo_list", 1, buildTodoDetail("pending")),
      buildItemCompleted("t1", "todo", "todo_list", 2, "failed", buildTodoDetail("pending")),
    ]);

    expect(failed[0]!.result).toBe("failed");
  });

  it("reads the final list from a todo list's completion, and keeps the list when it has none", () => {
    const started = buildItemStarted(
      "t1",
      "todo",
      "todo_list",
      1,
      buildTodoDetail("in_progress", "pending"),
    );
    const lostUpdate = buildItemUpdated("t1", "todo", "todo_list", 2);

    const recovered = buildRowsOf([
      started,
      lostUpdate,
      buildItemCompleted(
        "t1",
        "todo",
        "todo_list",
        3,
        "completed",
        buildTodoDetail("completed", "completed"),
      ),
    ]);
    const kept = buildRowsOf([
      started,
      buildItemCompleted("t1", "todo", "todo_list", 3, "completed", { steps: "bad" }),
    ]);

    expect(recovered[0]).toMatchObject({ label: "Tasks 2/2", result: "completed" });
    expect(recovered[0]!.todoSteps).toHaveLength(2);
    expect(kept[0]).toMatchObject({ label: "Tasks 0/2", target: "step 1" });
  });

  it("never folds two todo lists", () => {
    const rows = buildRowsOf([
      buildItemStarted("t1", "todo1", "todo_list", 1, buildTodoDetail("pending")),
      buildItemStarted("t1", "todo2", "todo_list", 2, buildTodoDetail("pending")),
    ]);

    expect(rows.map((row) => row.key)).toEqual(["row:todo1", "row:todo2"]);
  });

  it("draws a fetch as Fetched and its URL, in the mono face, and a search as Searched the web", () => {
    const rows = buildRowsOf([
      buildItemStarted("t1", "fetch", "web_search", 1, {
        name: "WebFetch",
        input: { url: "https://example.com/a", prompt: "Summarise" },
        url: "https://example.com/a",
      }),
      buildItemStarted("t1", "search", "web_search", 2, {
        name: "WebSearch",
        input: { query: "effect schema" },
        query: "effect schema",
      }),
    ]);

    expect(
      rows.map((row) => [row.icon, row.label, row.target, row.targetIsCode, row.steps.length]),
    ).toEqual([
      ["globe", "Fetched", "https://example.com/a", true, 0],
      ["globe", "Searched the web", "effect schema", false, 0],
    ]);
  });

  it("folds fetches into 'Fetched 3 pages' and never folds them with searches", () => {
    const fetch = (id: string, seconds: number) =>
      buildItemStarted("t1", id, "web_search", seconds, {
        name: "WebFetch",
        url: `https://x/${id}`,
      });
    const search = (id: string, seconds: number) =>
      buildItemStarted("t1", id, "web_search", seconds, { name: "WebSearch", query: id });

    const rows = buildRowsOf([
      fetch("f1", 1),
      fetch("f2", 2),
      fetch("f3", 3),
      search("s1", 4),
      search("s2", 5),
      fetch("f4", 6),
    ]);

    expect(rows.map((row) => [row.label, row.steps.length])).toEqual([
      ["Fetched 3 pages", 3],
      ["Searched the web 2 times", 2],
      ["Fetched", 0],
    ]);
  });

  it("names a call an MCP server made through the API connector <server>/<tool>, and folds calls only when tool and server match", () => {
    const call = (id: string, seconds: number, name: string, server?: string) =>
      buildItemStarted("t1", id, "tool_call", seconds, {
        name,
        input: {},
        kind: "mcp",
        ...(server === undefined ? {} : { server }),
      });

    const rows = buildRowsOf([
      call("c1", 1, "create_issue", "github"),
      call("c2", 2, "create_issue", "github"),
      call("c3", 3, "create_issue", "linear"),
      call("c4", 4, "mcp__github__create_issue"),
    ]);

    expect(rows.map((row) => [row.label, row.steps.length])).toEqual([
      ["Used github/create_issue 2 times", 2],
      ["linear/create_issue", 0],
      ["mcp__github__create_issue", 0],
    ]);
  });

  it("shows the updated list on the work item, with the step in progress as its target", () => {
    const blocks = buildThreadBlocks(
      [
        buildTurnStarted("t1", 0),
        ...buildUserMessage("t1", "u1", 0, "Hi"),
        buildItemStarted("t1", "todo", "todo_list", 1, buildTodoDetail("in_progress")),
        buildItemUpdated("t1", "todo", "todo_list", 2, buildTodoDetail("completed", "in_progress")),
      ],
      buildSessionAgentState(BUSY),
    );

    const work = findBlock(blocks, "work", "work:todo");

    expect(work.items).toEqual([
      expect.objectContaining({
        verb: "tasks",
        target: "step 2",
        todoSteps: buildTodoDetail("completed", "in_progress").steps,
      }),
    ]);
  });

  it("keeps the message being written as the open item while a todo list is open", () => {
    const writing = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Hi"),
      buildItemStarted("t1", "todo", "todo_list", 1, buildTodoDetail("in_progress")),
      buildItemStarted("t1", "a1", "assistant_message", 2),
    ];

    const open = buildThreadBlocks(writing, buildSessionAgentState(BUSY)).filter(
      (block) => block.kind === "agent",
    );
    expect(open).toEqual([expect.objectContaining({ itemId: "a1", open: true, live: true })]);

    // The turn ended while the message never completed and wrote nothing: no agent row comes back.
    const ended = buildThreadBlocks(
      [...writing, buildTurnCompleted("t1", 5, "interrupted")],
      buildSessionAgentState(IDLE),
    );
    expect(ended.some((block) => block.kind === "agent")).toBe(false);
  });
});
