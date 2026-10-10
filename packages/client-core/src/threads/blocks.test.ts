/**
 * Tests `buildThreadBlocks(rows, agent)`, which turns a thread's transcript
 * into the flat list of blocks the desktop draws.
 *
 * The fixtures follow the adapters' real shapes: a user message is an
 * `item.started` and an `item.completed` with the same time and
 * `detail: { text }`, and an assistant message's text arrives only in
 * `content.delta` rows. Times are seconds after 09:00.
 */
import { describe, expect, it } from "vitest";
import type { OpenRequest, Session, Subagent, TranscriptRow } from "@hercule/contract";
import { buildSessionAgentState, buildSubagentAgentState } from "./agent-state";
import { buildThreadBlocks, type ThreadBlock } from "./blocks";

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
): TranscriptRow =>
  buildRow({ _tag: "item.completed", ...buildEnvelope(seconds), turnId, itemId, kind, status });

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
  status: "idle",
  resumable: false,
  resumeHeld: false,
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

  it("draws no block for runtime error, usage and session rows", () => {
    const rows = [
      buildRow({ _tag: "session.started", ...buildEnvelope(0) }),
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Hi"),
      buildRow({ _tag: "runtime.error", ...buildEnvelope(1), class: "unknown" }),
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
});
