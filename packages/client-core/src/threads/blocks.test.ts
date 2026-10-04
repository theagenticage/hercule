/**
 * Tests `buildThreadBlocks(rows, session)`, which turns a thread's transcript
 * into the flat list of blocks the desktop draws.
 *
 * The fixtures follow the adapters' real shapes: a user message is an
 * `item.started` and an `item.completed` with the same time and
 * `detail: { text }`, and an assistant message's text arrives only in
 * `content.delta` rows. Times are seconds after 09:00.
 */
import { describe, expect, it } from "vitest";
import type { Session, TranscriptRow } from "@hercule/contract";
import { buildThreadBlocks, type ThreadBlock } from "./blocks";

type ProviderEvent = TranscriptRow["event"];
type ItemKind = Extract<ProviderEvent, { _tag: "item.started" }>["kind"];
type OpenRequest = NonNullable<Session["openRequest"]>;

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
  openRequest: null,
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

    expect(buildThreadBlocks(rows, IDLE)).toEqual([
      { kind: "user", key: "user:u1", itemId: "u1", text: "Say hi", at: buildInstant(0) },
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

    const blocks = buildThreadBlocks(rows, IDLE);

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

    const blocks = buildThreadBlocks(rows, IDLE);

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

    const writing = buildThreadBlocks(opening, BUSY);
    expect(listKeys(writing)).toEqual(["user:u1", "agent:a1", "user:u2"]);
    expect(findBlock(writing, "agent", "agent:a1")).toMatchObject({
      text: "",
      open: true,
      live: true,
    });

    const written = buildThreadBlocks([...opening, ...closing], BUSY);
    expect(findBlock(written, "agent", "agent:a1")).toMatchObject({
      text: "Hello there.",
      open: false,
      live: false,
    });
    // The agent has the steered message still to answer, so the working face
    // moves to a live row below it.
    expect(listKeys(written)).toEqual(["user:u1", "agent:a1", "user:u2", "live"]);
  });

  it("shows a live row for a session that is starting before any row", () => {
    expect(buildThreadBlocks([], { ...BASE, status: "starting" })).toEqual([
      { kind: "live", key: "live", model: "claude-sonnet-5" },
    ]);
    expect(buildThreadBlocks([], IDLE)).toEqual([]);
  });

  it("shows only the live row while a turn runs before its first item", () => {
    const rows = [buildTurnStarted("t1", 0, "gpt-5.5"), ...buildUserMessage("t1", "u1", 0, "Hi")];

    expect(buildThreadBlocks(rows, BUSY)).toEqual([
      expect.objectContaining({ key: "user:u1" }),
      { kind: "live", key: "live", model: "gpt-5.5" },
    ]);
  });

  it("draws no work block for a stretch of reasoning alone, and lists the reasoning once a tool joins it", () => {
    const thinking = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Hi"),
      buildItemStarted("t1", "r1", "reasoning", 1),
    ];
    expect(listKeys(buildThreadBlocks(thinking, BUSY))).toEqual(["user:u1", "live"]);

    const working = [...thinking, buildItemStarted("t1", "c1", "command_execution", 2)];
    const blocks = buildThreadBlocks(working, BUSY);
    expect(listKeys(blocks)).toEqual(["user:u1", "work:r1", "live"]);
    const work = findBlock(blocks, "work", "work:r1");
    expect(work.items.map((item) => item.kind)).toEqual(["reasoning", "command_execution"]);
    expect(work.endedAt).toBeNull();
  });

  it("puts the working face on the message the agent is writing, and shows no live row", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Hi"),
      ...buildCommand("t1", "c1", 1, 2),
      buildItemStarted("t1", "a1", "assistant_message", 3),
      // A 4 KB cut: part of the text is stored while the message is open.
      buildText("t1", "a1", 3, "Hel"),
    ];

    const blocks = buildThreadBlocks(rows, BUSY);

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

    const blocks = buildThreadBlocks(rows, BUSY);

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

    const waiting = buildThreadBlocks(answered, BUSY);
    expect(listKeys(waiting)).toEqual(["user:u1", "agent:a1"]);
    expect(findBlock(waiting, "agent", "agent:a1")).toMatchObject({ open: false, live: true });

    const ended = buildThreadBlocks([...answered, buildTurnCompleted("t1", 3)], IDLE);
    expect(listKeys(ended)).toEqual(["user:u1", "agent:a1"]);
    expect(findBlock(ended, "agent", "agent:a1").live).toBe(false);
  });

  it("moves the working face to a live row when a tool starts after the last message", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Hi"),
      ...buildAgentMessage("t1", "a1", 1, "Let me look."),
      buildItemStarted("t1", "c1", "command_execution", 3),
    ];

    const blocks = buildThreadBlocks(rows, BUSY);

    expect(listKeys(blocks)).toEqual(["user:u1", "agent:a1", "work:c1", "live"]);
    expect(findBlock(blocks, "agent", "agent:a1").live).toBe(false);
  });

  it("ends a stopped turn with its duration", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Hi"),
      buildItemStarted("t1", "c1", "command_execution", 1),
      buildTurnCompleted("t1", 4, "interrupted"),
    ];

    const blocks = buildThreadBlocks(rows, IDLE);

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

    expect(buildThreadBlocks(rows, IDLE)).toEqual([
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

    expect(findBlock(buildThreadBlocks(rows, IDLE), "ending", "ending:t1").duration).toBe(4000);
  });

  it("cuts a turn short where its session exited", () => {
    const rows = [
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Hi"),
      buildItemStarted("t1", "c1", "command_execution", 1),
      buildRow({ _tag: "session.exited", ...buildEnvelope(7), reason: "crash" }),
    ];

    const blocks = buildThreadBlocks(rows, { ...BASE, status: "exited" });

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

      const blocks = buildThreadBlocks(rows, { ...BASE, status });

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

      expect(buildThreadBlocks(rows, { ...BASE, status })).toEqual([
        expect.objectContaining({ key: "user:u1" }),
        { kind: "live", key: "live", model: "claude-sonnet-5" },
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

    const blocks = buildThreadBlocks(rows, { ...BASE, status: "starting" });

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

    expect(listKeys(buildThreadBlocks(rows, IDLE))).toEqual([
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

    const blocks = buildThreadBlocks(rows, IDLE);

    expect(listKeys(blocks)).toEqual(["user:u1", "work:c1", "ending:t1"]);
    expect(findBlock(blocks, "work", "work:c1").items[0]!.result).toBe("failed");
    expect(findBlock(blocks, "ending", "ending:t1").duration).toBe(3000);
  });

  it("draws no block for runtime, usage and session rows", () => {
    const rows = [
      buildRow({ _tag: "session.started", ...buildEnvelope(0) }),
      buildTurnStarted("t1", 0),
      ...buildUserMessage("t1", "u1", 0, "Hi"),
      buildRow({ _tag: "runtime.warning", ...buildEnvelope(1), turnId: "t1", message: "slow" }),
      buildRow({ _tag: "runtime.error", ...buildEnvelope(1), class: "unknown" }),
      buildRow({
        _tag: "session.usage.updated",
        ...buildEnvelope(1),
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
      ...buildAgentMessage("t1", "a1", 2, "Hello."),
      buildTurnCompleted("t1", 3),
    ];

    expect(listKeys(buildThreadBlocks(rows, IDLE))).toEqual(["user:u1", "agent:a1"]);
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

    const blocks = buildThreadBlocks(rows, { ...BUSY, openRequest: REQUEST });

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

    const blocks = buildThreadBlocks(rows, BUSY);

    expect(listKeys(blocks)).toEqual(["user:u1", "work:c1", "live"]);
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
      ...buildAgentMessage("t1", "a2", 7, "Done."),
      buildTurnCompleted("t1", 9, "interrupted"),
    ];
    const final = listKeys(buildThreadBlocks(rows, IDLE));

    for (let length = 1; length < rows.length; length++) {
      const keys = listKeys(buildThreadBlocks(rows.slice(0, length), BUSY)).filter(
        (key) => key !== "live",
      );
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

    const work = findBlock(buildThreadBlocks(rows, BUSY), "work", "work:claude");

    expect(work.items.map((item) => item.paths)).toEqual([
      ["src/a.ts"],
      ["src/b.ts", "src/c.ts"],
      ["src/d.ts"],
      [],
      [],
    ]);
  });
});
