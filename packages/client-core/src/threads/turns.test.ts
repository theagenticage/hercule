/**
 * Tests `buildTurns(rows, agent)`, which groups an agent's transcript rows
 * into turns, and `readUserSender`, which reads who sent a user message.
 *
 * The fixtures use the Claude adapter's real shapes (spec 06 §6.3, and
 * `apps/runner/src/providers/claude-code.ts` / `claude-code-normalize.ts`):
 *
 * - a `user_message` item has `detail: { text }` on both `item.started` and
 *   `item.completed`;
 * - a tool item's `detail` on `item.started` is `{ name, input, kind? }`;
 * - assistant text and reasoning arrive only as `content.delta`, never on the
 *   `assistant_message` item events.
 */
import { describe, expect, it } from "vitest";
import type { SessionRequest, TranscriptRow } from "@hercule/contract";
import type { AgentState } from "./agent-state";
import { buildTurns, readUserSender } from "./turns";

const SESSION_ID = "session-1";

/** Returns a busy agent whose open Requests are about the items `itemIds`. */
const buildAgentAskingAbout = (...itemIds: readonly string[]): AgentState => ({
  working: true,
  mayBeRunningTurn: true,
  openRequests: itemIds.map((itemId): SessionRequest => ({
    requestId: `r-${itemId}`,
    itemId,
    kind: "command_approval",
    decisions: ["allow", "deny"],
    detail: { command: "ls -la" },
  })),
  model: "claude-sonnet-5",
});

const AGENT_ASKING_NOTHING = buildAgentAskingAbout();

let idSeq = 0;
const nextId = (): string => `e${idSeq++}`;

const buildRow = (event: TranscriptRow["event"]): TranscriptRow => ({
  position: idSeq,
  at: event.at,
  event,
});

/** The `kind` of an `item.started` row, narrowed from the row union. */
type ItemKindType = Extract<TranscriptRow["event"], { _tag: "item.started" }>["kind"];

describe("buildTurns", () => {
  it("groups rows into turns: the user message, ordered tool items, and the streamed assistant text", () => {
    const rows: TranscriptRow[] = [
      buildRow({
        _tag: "turn.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:00.000Z",
        turnId: "t1",
      }),
      buildRow({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:00.100Z",
        turnId: "t1",
        itemId: "u1",
        kind: "user_message",
        detail: { text: "Fix the login bug" },
      }),
      buildRow({
        _tag: "item.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:00.100Z",
        turnId: "t1",
        itemId: "u1",
        kind: "user_message",
        status: "completed",
        detail: { text: "Fix the login bug" },
      }),
      buildRow({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:01.000Z",
        turnId: "t1",
        itemId: "tool1",
        kind: "command_execution",
        detail: { name: "Bash", input: { command: "ls -la" } },
      }),
      buildRow({
        _tag: "content.delta",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:02.000Z",
        turnId: "t1",
        itemId: "a1",
        streamKind: "assistant_text",
        delta: "I'll ",
      }),
      buildRow({
        _tag: "content.delta",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:02.500Z",
        turnId: "t1",
        itemId: "a1",
        streamKind: "assistant_text",
        delta: "look at the file.",
      }),
      buildRow({
        _tag: "item.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:03.000Z",
        turnId: "t1",
        itemId: "tool1",
        kind: "command_execution",
        status: "completed",
        detail: { name: "Bash", input: { command: "ls -la" } },
      }),
      buildRow({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:03.500Z",
        turnId: "t1",
        itemId: "a1",
        kind: "assistant_message",
      }),
      buildRow({
        _tag: "item.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:03.600Z",
        turnId: "t1",
        itemId: "a1",
        kind: "assistant_message",
        status: "completed",
      }),
      buildRow({
        _tag: "turn.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:05.000Z",
        turnId: "t1",
        state: "completed",
      }),
      buildRow({
        _tag: "turn.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:01:00.000Z",
        turnId: "t2",
      }),
      buildRow({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:01:00.100Z",
        turnId: "t2",
        itemId: "u2",
        kind: "user_message",
        detail: { text: "What about the tests?" },
      }),
      buildRow({
        _tag: "item.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:01:00.100Z",
        turnId: "t2",
        itemId: "u2",
        kind: "user_message",
        status: "completed",
        detail: { text: "What about the tests?" },
      }),
      buildRow({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:01:01.000Z",
        turnId: "t2",
        itemId: "edit1",
        kind: "file_change",
        detail: { name: "Edit", input: { path: "src/auth.ts" } },
      }),
      buildRow({
        _tag: "item.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:01:01.500Z",
        turnId: "t2",
        itemId: "edit1",
        kind: "file_change",
        status: "completed",
        detail: { name: "Edit", input: { path: "src/auth.ts" } },
      }),
      buildRow({
        _tag: "content.delta",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:01:02.000Z",
        turnId: "t2",
        itemId: "a2",
        streamKind: "assistant_text",
        delta: "Added a test too.",
      }),
      buildRow({
        _tag: "turn.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:01:03.000Z",
        turnId: "t2",
        state: "completed",
      }),
    ];

    const turns = buildTurns(rows, AGENT_ASKING_NOTHING).turns;

    expect(turns).toHaveLength(2);

    expect(turns[0]).toMatchObject({
      turnId: "t1",
      userMessages: [{ text: "Fix the login bug", steered: false }],
      assistantText: "I'll look at the file.",
      startedAt: "2026-09-08T10:00:00.000Z",
      duration: 5000,
      endState: "completed",
    });
    // user_message and assistant_message never appear in `items`.
    expect(turns[0]!.items.map((item) => item.itemId)).toEqual(["tool1"]);
    expect(turns[0]!.items[0]).toMatchObject({
      itemId: "tool1",
      kind: "command_execution",
      verb: "command",
      result: "completed",
    });
    // `target` is a one-line summary of a present `detail`.
    expect(turns[0]!.items[0]!.target).not.toBe("");
    expect(turns[0]!.items[0]!.target).not.toMatch(/\n/);

    expect(turns[1]).toMatchObject({
      turnId: "t2",
      userMessages: [{ text: "What about the tests?", steered: false }],
      assistantText: "Added a test too.",
      startedAt: "2026-09-08T10:01:00.000Z",
      duration: 3000,
    });
    expect(turns[1]!.items).toEqual([
      expect.objectContaining({ itemId: "edit1", verb: "edit", result: "completed" }),
    ]);
  });

  it("joins two distinct assistant_message items in one turn with a blank line, not a run-on sentence", () => {
    const rows: TranscriptRow[] = [
      buildRow({
        _tag: "turn.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:00.000Z",
        turnId: "t1",
      }),
      buildRow({
        _tag: "content.delta",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:01.000Z",
        turnId: "t1",
        itemId: "a1",
        streamKind: "assistant_text",
        delta: "Sleep 1 ",
      }),
      buildRow({
        _tag: "content.delta",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:01.500Z",
        turnId: "t1",
        itemId: "a1",
        streamKind: "assistant_text",
        delta: "of 4 finished.",
      }),
      buildRow({
        _tag: "content.delta",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:02.000Z",
        turnId: "t1",
        itemId: "a2",
        streamKind: "assistant_text",
        delta: "Sleep 2 of 4 finished.",
      }),
    ];

    const turns = buildTurns(rows, AGENT_ASKING_NOTHING).turns;

    expect(turns[0]!.assistantText).toBe("Sleep 1 of 4 finished.\n\nSleep 2 of 4 finished.");
  });

  it("summarizes a command item's target as the command it ran, not the raw JSON", () => {
    // The real Claude adapter's shape for a shell item (spec 06 §6.3's
    // command_execution): `{ name, input: { command, description } }`.
    const rows: TranscriptRow[] = [
      buildRow({
        _tag: "turn.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:00.000Z",
        turnId: "t1",
      }),
      buildRow({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:00.100Z",
        turnId: "t1",
        itemId: "tool1",
        kind: "command_execution",
        detail: {
          name: "Bash",
          input: { command: "ls -la", description: "List files" },
        },
      }),
    ];

    const turns = buildTurns(rows, AGENT_ASKING_NOTHING).turns;

    expect(turns[0]!.items[0]!.target).toBe("ls -la");
  });

  it("summarizes a web search's target as what it searched for, not the tool's name", () => {
    // The Claude adapter's shape for Claude Code's WebSearch tool.
    const turns = buildTurns(
      [
        buildRow({
          _tag: "item.started",
          eventId: nextId(),
          sessionId: SESSION_ID,
          at: "2026-09-08T10:00:00.000Z",
          turnId: "t-search",
          itemId: "t-search",
          kind: "web_search",
          detail: { name: "WebSearch", input: { query: "3-D Secure challenge timeout" } },
        }),
      ],
      AGENT_ASKING_NOTHING,
    ).turns;

    expect(turns[0]!.items[0]!.target).toBe("3-D Secure challenge timeout");
  });

  it("summarizes a file search's target as the pattern it looked for, not its path or tool", () => {
    const turns = buildTurns(
      [
        buildRow({
          _tag: "item.started",
          eventId: nextId(),
          sessionId: SESSION_ID,
          at: "2026-09-08T10:00:00.000Z",
          turnId: "t-grep",
          itemId: "t-grep",
          kind: "file_search",
          detail: { pattern: "handlePaymentResult", path: "src", name: "Grep" },
        }),
      ],
      AGENT_ASKING_NOTHING,
    ).turns;

    expect(turns[0]!.items[0]!.target).toBe("handlePaymentResult");
  });

  it("summarizes a file change of several files by its first path", () => {
    const turns = buildTurns(
      [
        buildRow({
          _tag: "item.started",
          eventId: nextId(),
          sessionId: SESSION_ID,
          at: "2026-09-08T10:00:00.000Z",
          turnId: "t-patch",
          itemId: "t-patch",
          kind: "file_change",
          detail: { paths: ["src/a.ts", "src/b.ts"] },
        }),
      ],
      AGENT_ASKING_NOTHING,
    ).turns;

    expect(turns[0]!.items[0]!.target).toBe("src/a.ts");
  });

  it("shows the raw JSON when the field it would summarize by is not a string", () => {
    const detail = { name: "McpTool", input: { command: 123 } };
    const turns = buildTurns(
      [
        buildRow({
          _tag: "item.started",
          eventId: nextId(),
          sessionId: SESSION_ID,
          at: "2026-09-08T10:00:00.000Z",
          turnId: "t-mcp",
          itemId: "t-mcp",
          kind: "tool_call",
          detail,
        }),
      ],
      AGENT_ASKING_NOTHING,
    ).turns;

    expect(turns[0]!.items[0]!.target).toBe(JSON.stringify(detail));
  });

  it("falls back from file_path to description, then name, then raw JSON", () => {
    const fileChange = buildTurns(
      [
        buildRow({
          _tag: "item.started",
          eventId: nextId(),
          sessionId: SESSION_ID,
          at: "2026-09-08T10:00:00.000Z",
          turnId: "t-path",
          itemId: "t-path",
          kind: "file_change",
          detail: { input: { file_path: "src/auth.ts" } },
        }),
      ],
      AGENT_ASKING_NOTHING,
    ).turns;
    expect(fileChange[0]!.items[0]!.target).toBe("src/auth.ts");

    const described = buildTurns(
      [
        buildRow({
          _tag: "item.started",
          eventId: nextId(),
          sessionId: SESSION_ID,
          at: "2026-09-08T10:00:00.000Z",
          turnId: "t-desc",
          itemId: "t-desc",
          kind: "file_change",
          detail: { input: { description: "Search the web" } },
        }),
      ],
      AGENT_ASKING_NOTHING,
    ).turns;
    expect(described[0]!.items[0]!.target).toBe("Search the web");

    const named = buildTurns(
      [
        buildRow({
          _tag: "item.started",
          eventId: nextId(),
          sessionId: SESSION_ID,
          at: "2026-09-08T10:00:00.000Z",
          turnId: "t-name",
          itemId: "t-name",
          kind: "file_change",
          detail: { name: "some_mcp_tool" },
        }),
      ],
      AGENT_ASKING_NOTHING,
    ).turns;
    expect(named[0]!.items[0]!.target).toBe("some_mcp_tool");

    const bare = buildTurns(
      [
        buildRow({
          _tag: "item.started",
          eventId: nextId(),
          sessionId: SESSION_ID,
          at: "2026-09-08T10:00:00.000Z",
          turnId: "t-json",
          itemId: "t-json",
          kind: "file_change",
          detail: { foo: "bar" },
        }),
      ],
      AGENT_ASKING_NOTHING,
    ).turns;
    expect(bare[0]!.items[0]!.target).toBe(JSON.stringify({ foo: "bar" }));
  });

  it("leaves duration null and marks the still-open item running while a turn has no turn.completed yet", () => {
    const rows: TranscriptRow[] = [
      buildRow({
        _tag: "turn.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T11:00:00.000Z",
        turnId: "t3",
      }),
      buildRow({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T11:00:00.100Z",
        turnId: "t3",
        itemId: "u3",
        kind: "user_message",
        detail: { text: "Run the tests" },
      }),
      buildRow({
        _tag: "item.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T11:00:00.100Z",
        turnId: "t3",
        itemId: "u3",
        kind: "user_message",
        status: "completed",
        detail: { text: "Run the tests" },
      }),
      buildRow({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T11:00:01.000Z",
        turnId: "t3",
        itemId: "tool3",
        kind: "command_execution",
        detail: { name: "Bash", input: { command: "pnpm test" } },
      }),
      // No item.completed for tool3, and no turn.completed: the turn is live.
    ];

    const turns = buildTurns(rows, AGENT_ASKING_NOTHING).turns;

    expect(turns).toHaveLength(1);
    expect(turns[0]!.duration).toBeNull();
    expect(turns[0]!.endState).toBeNull();
    expect(turns[0]!.items).toEqual([
      expect.objectContaining({ itemId: "tool3", result: "running" }),
    ]);
  });

  it("keeps how a turn ended, so a stopped or failed turn never reads as a normal one", () => {
    const endTurn = (turnId: string, state: "completed" | "failed" | "interrupted") => [
      buildRow({
        _tag: "turn.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T12:00:00.000Z",
        turnId,
      }),
      buildRow({
        _tag: "turn.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T12:00:22.000Z",
        turnId,
        state,
      }),
    ];

    const turns = buildTurns(
      [
        ...endTurn("done", "completed"),
        ...endTurn("broke", "failed"),
        ...endTurn("stopped", "interrupted"),
      ],
      AGENT_ASKING_NOTHING,
    ).turns;

    expect(turns.map((turn) => [turn.turnId, turn.endState, turn.duration])).toEqual([
      ["done", "completed", 22000],
      ["broke", "failed", 22000],
      ["stopped", "interrupted", 22000],
    ]);
  });

  it("passes a failed or declined item.completed status through as the item's result", () => {
    const rows: TranscriptRow[] = [
      buildRow({
        _tag: "turn.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T12:00:00.000Z",
        turnId: "t4",
      }),
      buildRow({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T12:00:00.500Z",
        turnId: "t4",
        itemId: "edit4",
        kind: "file_change",
        detail: { name: "Edit", input: { path: "src/broken.ts" } },
      }),
      buildRow({
        _tag: "item.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T12:00:01.000Z",
        turnId: "t4",
        itemId: "edit4",
        kind: "file_change",
        status: "failed",
        detail: { name: "Edit", input: { path: "src/broken.ts" } },
      }),
      buildRow({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T12:00:01.500Z",
        turnId: "t4",
        itemId: "tool4",
        kind: "tool_call",
        detail: { name: "mcp__example__do_thing", input: {}, kind: "mcp" },
      }),
      buildRow({
        _tag: "item.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T12:00:02.000Z",
        turnId: "t4",
        itemId: "tool4",
        kind: "tool_call",
        status: "declined",
        detail: { name: "mcp__example__do_thing", input: {}, kind: "mcp" },
      }),
      buildRow({
        _tag: "turn.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T12:00:02.500Z",
        turnId: "t4",
        state: "completed",
      }),
    ];

    const turns = buildTurns(rows, AGENT_ASKING_NOTHING).turns;

    expect(turns[0]!.items).toEqual([
      expect.objectContaining({ itemId: "edit4", verb: "edit", result: "failed" }),
      expect.objectContaining({ itemId: "tool4", verb: "tool", result: "declined" }),
    ]);
  });

  it("shows an item kind this build does not know as unknown, rather than crashing", () => {
    const novelKind = "audio_generation" as unknown as ItemKindType;

    const rows: TranscriptRow[] = [
      buildRow({
        _tag: "turn.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T13:00:00.000Z",
        turnId: "t5",
      }),
      buildRow({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T13:00:00.500Z",
        turnId: "t5",
        itemId: "novel1",
        // A kind this build does not know, cast past the type to simulate a
        // future harness that sends something unmapped. An unknown kind must
        // render as a generic row and never crash the transcript (spec 06 §6).
        kind: novelKind,
        detail: { note: "review mode" },
      }),
      buildRow({
        _tag: "item.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T13:00:01.000Z",
        turnId: "t5",
        itemId: "novel1",
        kind: novelKind,
        status: "completed",
        detail: { note: "review mode" },
      }),
      buildRow({
        _tag: "turn.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T13:00:01.500Z",
        turnId: "t5",
        state: "completed",
      }),
    ];

    const turns = buildTurns(rows, AGENT_ASKING_NOTHING).turns;

    expect(turns[0]!.items).toEqual([
      expect.objectContaining({ itemId: "novel1", verb: "unknown" }),
    ]);
  });

  it("has no items when a turn has only the user and assistant messages", () => {
    const rows: TranscriptRow[] = [
      buildRow({
        _tag: "turn.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T14:00:00.000Z",
        turnId: "t6",
      }),
      buildRow({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T14:00:00.100Z",
        turnId: "t6",
        itemId: "u6",
        kind: "user_message",
        detail: { text: "Say hi" },
      }),
      buildRow({
        _tag: "item.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T14:00:00.100Z",
        turnId: "t6",
        itemId: "u6",
        kind: "user_message",
        status: "completed",
        detail: { text: "Say hi" },
      }),
      buildRow({
        _tag: "content.delta",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T14:00:00.500Z",
        turnId: "t6",
        itemId: "a6",
        streamKind: "assistant_text",
        delta: "Hi!",
      }),
      buildRow({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T14:00:00.600Z",
        turnId: "t6",
        itemId: "a6",
        kind: "assistant_message",
      }),
      buildRow({
        _tag: "item.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T14:00:00.700Z",
        turnId: "t6",
        itemId: "a6",
        kind: "assistant_message",
        status: "completed",
      }),
      buildRow({
        _tag: "turn.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T14:00:01.000Z",
        turnId: "t6",
        state: "completed",
      }),
    ];

    const turns = buildTurns(rows, AGENT_ASKING_NOTHING).turns;

    expect(turns[0]!.items).toEqual([]);
    expect(turns[0]!.assistantText).toBe("Hi!");
  });

  it("sets target to an empty string when item.started has no detail", () => {
    const rows: TranscriptRow[] = [
      buildRow({
        _tag: "turn.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T15:00:00.000Z",
        turnId: "t7",
      }),
      buildRow({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T15:00:00.500Z",
        turnId: "t7",
        itemId: "tool7",
        kind: "tool_call",
        // no `detail`
      }),
      buildRow({
        _tag: "item.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T15:00:01.000Z",
        turnId: "t7",
        itemId: "tool7",
        kind: "tool_call",
        status: "completed",
      }),
      buildRow({
        _tag: "turn.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T15:00:01.500Z",
        turnId: "t7",
        state: "completed",
      }),
    ];

    const turns = buildTurns(rows, AGENT_ASKING_NOTHING).turns;

    expect(turns[0]!.items[0]!.target).toBe("");
  });

  it("keeps the owner's message and an agent's message steered into the same turn apart", () => {
    const rows: TranscriptRow[] = [
      buildRow({
        _tag: "turn.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T16:00:00.000Z",
        turnId: "t8",
      }),
      buildRow({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T16:00:00.100Z",
        turnId: "t8",
        itemId: "u8a",
        kind: "user_message",
        detail: { text: "Fix the login bug" },
      }),
      buildRow({
        _tag: "item.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T16:00:00.100Z",
        turnId: "t8",
        itemId: "u8a",
        kind: "user_message",
        status: "completed",
        detail: { text: "Fix the login bug" },
      }),
      // Another session's agent steers a message into the running turn: it
      // joins the turn as a second user_message rather than starting a new one.
      buildRow({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T16:00:01.000Z",
        turnId: "t8",
        itemId: "u8b",
        kind: "user_message",
        detail: { text: "Also check auth.ts", steered: true, senderSessionId: "s-sender" },
      }),
      buildRow({
        _tag: "item.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T16:00:01.000Z",
        turnId: "t8",
        itemId: "u8b",
        kind: "user_message",
        status: "completed",
        detail: { text: "Also check auth.ts", steered: true, senderSessionId: "s-sender" },
      }),
      buildRow({
        _tag: "turn.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T16:00:02.000Z",
        turnId: "t8",
        state: "completed",
      }),
    ];

    const turns = buildTurns(rows, AGENT_ASKING_NOTHING).turns;

    expect(turns).toHaveLength(1);
    expect(turns[0]!.userMessages).toEqual([
      { itemId: "u8a", text: "Fix the login bug", attachments: [], skills: [], steered: false },
      {
        itemId: "u8b",
        text: "Also check auth.ts",
        attachments: [],
        skills: [],
        steered: true,
        senderSessionId: "s-sender",
      },
    ]);
  });
});

/**
 * The item a session's open request is about shows `awaiting approval`
 * instead of `running`, so the transcript line for a Request's `itemId`
 * matches what the card above the composer is asking about.
 */
describe("buildTurns: the item an open request is about", () => {
  const buildParkedRows = (): TranscriptRow[] => [
    buildRow({
      _tag: "turn.started",
      eventId: nextId(),
      sessionId: SESSION_ID,
      at: "2026-09-08T17:00:00.000Z",
      turnId: "t9",
    }),
    buildRow({
      _tag: "item.started",
      eventId: nextId(),
      sessionId: SESSION_ID,
      at: "2026-09-08T17:00:01.000Z",
      turnId: "t9",
      itemId: "tool9",
      kind: "command_execution",
      detail: { name: "Bash", input: { command: "ls -la" } },
    }),
    buildRow({
      _tag: "item.started",
      eventId: nextId(),
      sessionId: SESSION_ID,
      at: "2026-09-08T17:00:02.000Z",
      turnId: "t9",
      itemId: "tool10",
      kind: "file_change",
      detail: { input: { file_path: "src/auth.ts" } },
    }),
  ];

  it("marks the item of the open request as awaiting approval, and only that one", () => {
    const items = buildTurns(buildParkedRows(), buildAgentAskingAbout("tool9")).turns[0]!.items;

    expect(items.find((item) => item.itemId === "tool9")!.result).toBe("awaiting approval");
    expect(items.find((item) => item.itemId === "tool10")!.result).toBe("running");
  });

  it("marks the item of each open request as awaiting approval", () => {
    const items = buildTurns(buildParkedRows(), buildAgentAskingAbout("tool9", "tool10")).turns[0]!
      .items;

    expect(items.map((item) => item.result)).toEqual(["awaiting approval", "awaiting approval"]);
  });

  it("marks every open item as running when no request is open", () => {
    const items = buildTurns(buildParkedRows(), AGENT_ASKING_NOTHING).turns[0]!.items;

    expect(items.map((item) => item.result)).toEqual(["running", "running"]);
  });

  it("keeps a finished item's result, even when the open request refers to it", () => {
    const rows = [
      ...buildParkedRows(),
      buildRow({
        _tag: "item.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T17:00:03.000Z",
        turnId: "t9",
        itemId: "tool9",
        kind: "command_execution",
        status: "completed",
        detail: { name: "Bash", input: { command: "ls -la" } },
      }),
    ];

    expect(
      buildTurns(rows, buildAgentAskingAbout("tool9")).turns[0]!.items.find(
        (item) => item.itemId === "tool9",
      )!.result,
    ).toBe("completed");
  });

  it("keeps the images of each message the user sent in a turn with that message", () => {
    const first = {
      id: "01920000-0000-7000-8000-000000000001",
      name: "before.png",
      mimeType: "image/png",
      sizeBytes: 2048,
    };
    const second = {
      id: "01920000-0000-7000-8000-000000000002",
      name: "after.webp",
      mimeType: "image/webp",
      sizeBytes: 4096,
    };
    const buildUserStarted = (
      itemId: string,
      detail: Extract<TranscriptRow["event"], { _tag: "item.started" }>["detail"] & object,
    ): TranscriptRow =>
      buildRow({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:00.100Z",
        turnId: "t1",
        itemId,
        kind: "user_message",
        detail,
      });
    const rows = [
      buildUserStarted("u1", { text: "Compare these", attachments: [first] }),
      buildUserStarted("u2", { text: "and this one" }),
      buildUserStarted("u3", { text: "", attachments: [second] }),
    ];

    const [turn] = buildTurns(rows, AGENT_ASKING_NOTHING).turns;

    expect(turn?.userMessages.map((message) => message.attachments)).toEqual([
      [first],
      [],
      [second],
    ]);
  });

  it("gives a message that carries no images an empty list, the same one every time the rows are grouped", () => {
    const rows = [
      buildRow({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:00.100Z",
        turnId: "t1",
        itemId: "u1",
        kind: "user_message",
        detail: { text: "Fix the login bug" },
      }),
    ];

    const attachments = buildTurns(rows, AGENT_ASKING_NOTHING).turns[0]?.userMessages[0]
      ?.attachments;
    expect(attachments).toEqual([]);
    // A memoized message compares its props by identity, so a fresh empty
    // list on each streamed row would draw it again for nothing.
    expect(buildTurns(rows, AGENT_ASKING_NOTHING).turns[0]?.userMessages[0]?.attachments).toBe(
      attachments,
    );
  });
});

describe("buildTurns: the skills of a message", () => {
  const buildUserStarted = (itemId: string, detail: Record<string, unknown>): TranscriptRow =>
    buildRow({
      _tag: "item.started",
      eventId: nextId(),
      sessionId: SESSION_ID,
      at: "2026-09-08T10:00:00.100Z",
      turnId: "t1",
      itemId,
      kind: "user_message",
      detail: detail as Extract<TranscriptRow["event"], { _tag: "item.started" }>["detail"] &
        object,
    });

  it("keeps the skills the runner listed for each message, in order", () => {
    const [turn] = buildTurns(
      [
        buildUserStarted("u1", {
          text: "$review and $webshop:release",
          skills: ["review", "webshop:release"],
        }),
        buildUserStarted("u2", { text: "plain" }),
      ],
      AGENT_ASKING_NOTHING,
    ).turns;

    expect(turn?.userMessages.map((message) => message.skills)).toEqual([
      ["review", "webshop:release"],
      [],
    ]);
  });

  it("skips what is not a name, and treats a skills field that is not a list as none", () => {
    const [turn] = buildTurns(
      [
        buildUserStarted("u1", { text: "x", skills: ["review", 3, null, { name: "a" }] }),
        buildUserStarted("u2", { text: "x", skills: "review" }),
        buildUserStarted("u3", { text: "x", skills: [4] }),
      ],
      AGENT_ASKING_NOTHING,
    ).turns;

    expect(turn?.userMessages.map((message) => message.skills)).toEqual([["review"], [], []]);
  });

  it("gives a message with no skills the same empty list every time the rows are grouped", () => {
    const rows = [buildUserStarted("u1", { text: "Fix the login bug" })];

    const skills = buildTurns(rows, AGENT_ASKING_NOTHING).turns[0]?.userMessages[0]?.skills;
    expect(skills).toEqual([]);
    expect(buildTurns(rows, AGENT_ASKING_NOTHING).turns[0]?.userMessages[0]?.skills).toBe(skills);
  });
});

describe("buildTurns runtime notes", () => {
  const INSTALL_COMMAND = "hercule runner install-harness r1 --provider claude-code";
  const base = (position: number, at: string) => ({
    eventId: `n${position}`,
    sessionId: SESSION_ID,
    at,
  });
  const row = (position: number, event: TranscriptRow["event"]): TranscriptRow => ({
    position,
    at: event.at,
    event,
  });
  const turnStarted = (position: number, turnId: string, at: string): TranscriptRow =>
    row(position, { _tag: "turn.started", ...base(position, at), turnId });
  const turnCompleted = (position: number, turnId: string, at: string): TranscriptRow =>
    row(position, { _tag: "turn.completed", ...base(position, at), turnId, state: "failed" });
  const errorRow = (position: number, at: string, over: { turnId?: string; message?: string }) =>
    row(position, {
      _tag: "runtime.error",
      ...base(position, at),
      class: "HarnessNotInstalled",
      ...over,
    });

  it("puts an error that names its turn in that turn, with the message as the runner wrote it", () => {
    const { turns, outsideRuntimeNotes } = buildTurns(
      [
        turnStarted(1, "t1", "2026-09-08T10:00:00.000Z"),
        errorRow(2, "2026-09-08T10:00:01.000Z", { turnId: "t1", message: "Context window full." }),
        turnCompleted(3, "t1", "2026-09-08T10:00:02.000Z"),
      ],
      AGENT_ASKING_NOTHING,
    );

    expect(outsideRuntimeNotes).toEqual([]);
    expect(turns[0]?.runtimeNotes).toEqual([
      {
        key: "runtime.error:2",
        severity: "error",
        message: "Context window full.",
        at: "2026-09-08T10:00:01.000Z",
      },
    ]);
  });

  it("puts an error with no turn id in the turn that is open where its row sits", () => {
    const { turns, outsideRuntimeNotes } = buildTurns(
      [
        turnStarted(1, "t1", "2026-09-08T10:00:00.000Z"),
        errorRow(2, "2026-09-08T10:00:01.000Z", { message: "Rate limited." }),
      ],
      AGENT_ASKING_NOTHING,
    );

    expect(outsideRuntimeNotes).toEqual([]);
    expect(turns[0]?.runtimeNotes.map((note) => note.message)).toEqual(["Rate limited."]);
  });

  it("keeps an error outside every turn when no turn ever began, as when a session fails to start", () => {
    const { turns, outsideRuntimeNotes } = buildTurns(
      [
        errorRow(1, "2026-09-08T10:00:00.000Z", {
          message: `Claude Code is not installed on this runner. Install it with: \`${INSTALL_COMMAND}\``,
        }),
      ],
      AGENT_ASKING_NOTHING,
    );

    expect(turns).toEqual([]);
    expect(outsideRuntimeNotes).toEqual([
      {
        key: "runtime.error:1",
        severity: "error",
        message: expect.stringContaining(INSTALL_COMMAND) as unknown,
        at: "2026-09-08T10:00:00.000Z",
        turnsBefore: 0,
      },
    ]);
  });

  it("counts the turns before an outside runtime note, and treats a completed or a restarted session's turn as closed", () => {
    const { turns, outsideRuntimeNotes } = buildTurns(
      [
        turnStarted(1, "t1", "2026-09-08T10:00:00.000Z"),
        turnCompleted(2, "t1", "2026-09-08T10:00:01.000Z"),
        errorRow(3, "2026-09-08T10:00:02.000Z", { message: "after a completed turn" }),
        turnStarted(4, "t2", "2026-09-08T10:00:03.000Z"),
        row(5, {
          _tag: "session.exited",
          ...base(5, "2026-09-08T10:00:04.000Z"),
          reason: "crash",
        }),
        errorRow(6, "2026-09-08T10:00:05.000Z", { message: "after an abandoned turn" }),
      ],
      AGENT_ASKING_NOTHING,
    );

    expect(turns.map((turn) => turn.runtimeNotes)).toEqual([[], []]);
    expect(outsideRuntimeNotes.map((note) => [note.message, note.turnsBefore])).toEqual([
      ["after a completed turn", 1],
      ["after an abandoned turn", 2],
    ]);
  });

  it("returns a runtime notice as a notice, in the turn it names or the turn open where its row sits", () => {
    const { turns, outsideRuntimeNotes } = buildTurns(
      [
        turnStarted(1, "t1", "2026-09-08T10:00:00.000Z"),
        row(2, {
          _tag: "runtime.notice",
          ...base(2, "2026-09-08T10:00:01.000Z"),
          turnId: "t1",
          message: "Recalled 2 memories",
        }),
        row(3, {
          _tag: "runtime.notice",
          ...base(3, "2026-09-08T10:00:02.000Z"),
          message: "Conversation was cleared",
        }),
        turnCompleted(4, "t1", "2026-09-08T10:00:03.000Z"),
        row(5, {
          _tag: "runtime.notice",
          ...base(5, "2026-09-08T10:00:04.000Z"),
          message: "Between turns",
        }),
      ],
      AGENT_ASKING_NOTHING,
    );

    expect(turns[0]?.runtimeNotes.map((note) => [note.key, note.severity, note.message])).toEqual([
      ["runtime.notice:2", "notice", "Recalled 2 memories"],
      ["runtime.notice:3", "notice", "Conversation was cleared"],
    ]);
    expect(outsideRuntimeNotes.map((note) => [note.severity, note.message])).toEqual([
      ["notice", "Between turns"],
    ]);
  });

  it("returns an unknown event as a notice naming its type in plain text, placed like a warning", () => {
    const unknownRow = (position: number, originalType: string) =>
      row(position, {
        _tag: "unknown",
        ...base(position, "2026-09-08T10:00:01.000Z"),
        originalType,
        payload: { _tag: originalType },
      });
    const { turns, outsideRuntimeNotes } = buildTurns(
      [
        unknownRow(1, "before.any.turn"),
        turnStarted(2, "t1", "2026-09-08T10:00:00.000Z"),
        unknownRow(3, "turn.`plan`.updated"),
      ],
      AGENT_ASKING_NOTHING,
    );

    expect(outsideRuntimeNotes.map((note) => [note.severity, note.message])).toEqual([
      ["notice", "Unknown event: before.any.turn"],
    ]);
    expect(turns[0]?.runtimeNotes.map((note) => [note.key, note.severity, note.message])).toEqual([
      ["unknown:3", "notice", "Unknown event: turn.plan.updated"],
    ]);
  });

  it("returns a warning as a warning, and an error with no message as its class", () => {
    const { turns } = buildTurns(
      [
        turnStarted(1, "t1", "2026-09-08T10:00:00.000Z"),
        row(2, {
          _tag: "runtime.warning",
          ...base(2, "2026-09-08T10:00:01.000Z"),
          message: "Retrying the request.",
        }),
        errorRow(3, "2026-09-08T10:00:02.000Z", {}),
      ],
      AGENT_ASKING_NOTHING,
    );

    expect(turns[0]?.runtimeNotes.map((note) => [note.severity, note.message])).toEqual([
      ["warning", "Retrying the request."],
      ["error", "HarnessNotInstalled"],
    ]);
  });
});

describe("readUserSender", () => {
  it("returns the sending session's id, and undefined when the message has no sender", () => {
    expect(readUserSender({ text: "Rebase on main", senderSessionId: "s-sender" })).toBe(
      "s-sender",
    );
    expect(readUserSender({ text: "Fix the login bug" })).toBeUndefined();
    expect(readUserSender({ text: "Fix the login bug", senderSessionId: "" })).toBeUndefined();
    expect(readUserSender(undefined)).toBeUndefined();
  });
});

describe("buildTurns: compaction and unknown items", () => {
  /** Returns a turn with one item of `kind`, started with `startDetail` and, when `completion` is given, completed. */
  const buildItemRows = (
    kind: "context_compaction" | "unknown",
    startDetail: unknown,
    completion?: { readonly status: "completed" | "failed"; readonly detail?: unknown },
  ): TranscriptRow[] => [
    buildRow({
      _tag: "turn.started",
      eventId: nextId(),
      sessionId: SESSION_ID,
      at: "2026-10-28T09:00:00.000Z",
      turnId: "t1",
    }),
    buildRow({
      _tag: "item.started",
      eventId: nextId(),
      sessionId: SESSION_ID,
      at: "2026-10-28T09:00:01.000Z",
      turnId: "t1",
      itemId: "i1",
      kind,
      ...(startDetail === undefined ? {} : { detail: startDetail as never }),
    }),
    ...(completion === undefined
      ? []
      : [
          buildRow({
            _tag: "item.completed",
            eventId: nextId(),
            sessionId: SESSION_ID,
            at: "2026-10-28T09:00:02.000Z",
            turnId: "t1",
            itemId: "i1",
            kind,
            status: completion.status,
            ...(completion.detail === undefined ? {} : { detail: completion.detail as never }),
          }),
        ]),
  ];

  const COMPLETED_DETAIL = {
    trigger: "auto",
    tokensBefore: 182_000,
    tokensAfter: 31_000,
    summary: "The user asked for a login fix.",
  };

  it("reads a compaction's counts from the row that completes it, not from its start", () => {
    const rows = buildItemRows("context_compaction", undefined, {
      status: "completed",
      detail: COMPLETED_DETAIL,
    });

    expect(buildTurns(rows, AGENT_ASKING_NOTHING).turns[0]!.items).toEqual([
      {
        itemId: "i1",
        kind: "context_compaction",
        verb: "compaction",
        target: "182k → 31k tokens (auto)",
        result: "completed",
        todoSteps: [],
      },
    ]);
  });

  it("shows a running compaction with no words after its verb", () => {
    const items = buildTurns(buildItemRows("context_compaction", undefined), AGENT_ASKING_NOTHING)
      .turns[0]!.items;

    expect(items[0]).toMatchObject({ verb: "compaction", target: "", result: "running" });
  });

  it("reads the counts a compaction started with, and keeps them when it completes with no detail", () => {
    const rows = buildItemRows(
      "context_compaction",
      { trigger: "manual", tokensBefore: 21_326, tokensAfter: 6086 },
      { status: "failed" },
    );

    expect(buildTurns(rows, AGENT_ASKING_NOTHING).turns[0]!.items[0]).toMatchObject({
      target: "21.3k → 6.1k tokens (manual)",
      result: "failed",
    });
  });

  it("merges what a compaction started with and what it completed with, the completion winning", () => {
    const rows = buildItemRows(
      "context_compaction",
      { trigger: "auto", tokensBefore: 182_000, tokensAfter: 40_000 },
      {
        status: "completed",
        detail: { tokensAfter: 31_000, summary: "The user asked for a fix." },
      },
    );

    expect(buildTurns(rows, AGENT_ASKING_NOTHING).turns[0]!.items[0]).toMatchObject({
      target: "182k → 31k tokens (auto)",
      result: "completed",
    });
  });

  it("shows a compaction row written with the old field names without any counts", () => {
    const rows = buildItemRows("context_compaction", undefined, {
      status: "completed",
      detail: { trigger: "auto", preTokens: 182_000, postTokens: 31_000 },
    });

    expect(buildTurns(rows, AGENT_ASKING_NOTHING).turns[0]!.items[0]).toMatchObject({
      verb: "compaction",
      target: "",
      result: "completed",
    });
  });

  it("shows an unknown item's label as its target", () => {
    const rows = buildItemRows("unknown", { label: "claude: system/foo_bar" });

    expect(buildTurns(rows, AGENT_ASKING_NOTHING).turns[0]!.items[0]).toMatchObject({
      verb: "unknown",
      target: "claude: system/foo_bar",
    });
  });

  it("shows an unknown item with no detail as an unknown item with no target", () => {
    const items = buildTurns(buildItemRows("unknown", undefined), AGENT_ASKING_NOTHING).turns[0]!
      .items;

    expect(items[0]).toMatchObject({ verb: "unknown", target: "" });
  });
});

describe("buildTurns: todo lists, page fetches and MCP calls", () => {
  const AT = "2026-10-29T09:00:00.000Z";
  type Status = "pending" | "in_progress" | "completed";

  const todo = (...statuses: readonly Status[]) => ({
    steps: statuses.map((status, index) => ({ text: `step ${index + 1}`, status })),
  });

  /** Returns the rows of a turn that starts an item of `kind`, then runs `events` on it. */
  const buildRowsOfItem = (
    kind: ItemKindType,
    startDetail: unknown,
    ...events: readonly (
      | { readonly _tag: "item.updated"; readonly detail?: unknown }
      | {
          readonly _tag: "item.completed";
          readonly status: "completed" | "failed";
          readonly detail?: unknown;
        }
    )[]
  ): TranscriptRow[] => [
    buildRow({
      _tag: "turn.started",
      eventId: nextId(),
      sessionId: SESSION_ID,
      at: AT,
      turnId: "t1",
    }),
    buildRow({
      _tag: "item.started",
      eventId: nextId(),
      sessionId: SESSION_ID,
      at: AT,
      turnId: "t1",
      itemId: "i1",
      kind,
      detail: startDetail as never,
    }),
    ...events.map((event) =>
      event._tag === "item.updated"
        ? buildRow({
            _tag: "item.updated",
            eventId: nextId(),
            sessionId: SESSION_ID,
            at: AT,
            turnId: "t1",
            itemId: "i1",
            kind,
            ...(event.detail === undefined ? {} : { detail: event.detail as never }),
          })
        : buildRow({
            _tag: "item.completed",
            eventId: nextId(),
            sessionId: SESSION_ID,
            at: AT,
            turnId: "t1",
            itemId: "i1",
            kind,
            status: event.status,
            ...(event.detail === undefined ? {} : { detail: event.detail as never }),
          }),
    ),
  ];

  const readItems = (rows: readonly TranscriptRow[]) =>
    buildTurns(rows, AGENT_ASKING_NOTHING).turns[0]!.items;

  it("draws a todo list as one item, tasks with its progress and current step, that updates in place", () => {
    const rows = buildRowsOfItem(
      "todo_list",
      todo("in_progress", "pending"),
      { _tag: "item.updated", detail: todo("completed", "in_progress") },
      { _tag: "item.updated", detail: todo("completed", "completed") },
    );

    expect(readItems(rows)).toEqual([
      {
        itemId: "i1",
        kind: "todo_list",
        verb: "tasks",
        target: "2/2",
        result: "completed",
        todoSteps: todo("completed", "completed").steps,
      },
    ]);
    expect(readItems(rows.slice(0, 3))[0]!.target).toBe("1/2 · step 2");
    expect(readItems(rows.slice(0, 2))[0]!.target).toBe("0/2 · step 1");
  });

  it("keeps the list when an update has no detail or one that does not decode", () => {
    const rows = buildRowsOfItem(
      "todo_list",
      todo("in_progress", "pending"),
      { _tag: "item.updated" },
      { _tag: "item.updated", detail: { steps: 3 } },
      { _tag: "item.updated", detail: { steps: [{ text: "step 9", status: "blocked" }] } },
      { _tag: "item.updated", detail: { steps: [{ text: "", status: "pending" }] } },
    );

    expect(readItems(rows)[0]).toMatchObject({
      target: "0/2 · step 1",
      todoSteps: todo("in_progress", "pending").steps,
    });
  });

  it("names the first step in progress, and just the progress when none is or the list is empty", () => {
    const targetOf = (detail: unknown) => readItems(buildRowsOfItem("todo_list", detail))[0]!;

    expect(targetOf(todo("completed", "in_progress", "in_progress", "pending")).target).toBe(
      "1/4 · step 2",
    );
    expect(targetOf(todo("completed", "pending")).target).toBe("1/2");
    expect(targetOf({ steps: [] })).toMatchObject({ target: "0/0", todoSteps: [] });
  });

  it("shows only the first line of a step, cut like any other target", () => {
    const tall = { steps: [{ text: "First line\nsecond line", status: "in_progress" }] };
    const wide = { steps: [{ text: "x".repeat(512), status: "in_progress" }] };

    expect(readItems(buildRowsOfItem("todo_list", tall))[0]!.target).toBe("0/1 · First line");
    const target = readItems(buildRowsOfItem("todo_list", wide))[0]!.target;
    expect(target).toBe(`0/1 · ${"x".repeat(194)}…`);
    // The steps themselves are not cut: the divider lists them whole.
    expect(readItems(buildRowsOfItem("todo_list", wide))[0]!.todoSteps[0]!.text).toHaveLength(512);
  });

  it.each([
    [{ durationMs: 30_000 }, "30s"],
    [{ durationMs: 90_000 }, "1m 30s"],
    [{ durationMs: 500 }, "500ms"],
    // Not the raw JSON: a detail that does not decode has nothing to show.
    [{ durationMs: "30s" }, ""],
    [undefined, ""],
  ])("shows a wait of %j as the word wait and the duration %j", (detail, target) => {
    expect(readItems(buildRowsOfItem("wait", detail))[0]).toMatchObject({ verb: "wait", target });
  });

  it("shows an image generation as the word image and the path it saved the image to, or nothing", () => {
    expect(
      readItems(buildRowsOfItem("image_generation", { path: "/tmp/logo.png" }))[0],
    ).toMatchObject({ verb: "image", target: "/tmp/logo.png" });
    expect(readItems(buildRowsOfItem("image_generation", {}))[0]).toMatchObject({
      verb: "image",
      target: "",
    });
  });

  it("shows the path an image generation saved from the update before its completion, and keeps it through the completion", () => {
    // Codex saves the file at the end: the start has no path, the update right before the completion has it.
    const rows = buildRowsOfItem(
      "image_generation",
      {},
      { _tag: "item.updated", detail: { path: "/tmp/late.png" } },
      { _tag: "item.completed", status: "completed" },
    );

    expect(readItems(rows)[0]).toMatchObject({ target: "/tmp/late.png", result: "completed" });
  });

  it("draws an update that turns a search into a fetch as a fetch, and keeps that when the next update has no detail", () => {
    const rows = buildRowsOfItem(
      "web_search",
      { query: "effect schema" },
      { _tag: "item.updated", detail: { url: "https://example.com/a" } },
      { _tag: "item.updated" },
    );

    expect(readItems(rows.slice(0, 2))[0]).toMatchObject({
      verb: "search",
      target: "effect schema",
    });
    expect(readItems(rows)[0]).toMatchObject({ verb: "fetch", target: "https://example.com/a" });
  });

  it("merges a compaction's completion over its latest update, not over its start", () => {
    const rows = buildRowsOfItem(
      "context_compaction",
      { trigger: "auto", tokensBefore: 100_000 },
      { _tag: "item.updated", detail: { trigger: "auto", tokensBefore: 182_000 } },
      // A detail that does not decode leaves the latest one in place.
      { _tag: "item.updated", detail: { tokensBefore: "lots" } },
      { _tag: "item.completed", status: "completed", detail: { tokensAfter: 31_000 } },
    );

    expect(readItems(rows)[0]!.target).toBe("182k → 31k tokens (auto)");
  });

  it("ignores an update for an item that never started", () => {
    const rows = buildRowsOfItem("todo_list", todo("pending"));
    const update = buildRow({
      _tag: "item.updated",
      eventId: nextId(),
      sessionId: SESSION_ID,
      at: AT,
      turnId: "t1",
      itemId: "ghost",
      kind: "todo_list",
      detail: todo("completed") as never,
    });

    expect(readItems([...rows, update])).toHaveLength(1);
  });

  it("reads the final list from a todo list's completion, and keeps the list when it has none", () => {
    const completion = (detail?: unknown) =>
      buildRow({
        _tag: "item.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: AT,
        turnId: "t1",
        itemId: "i1",
        kind: "todo_list",
        status: "completed",
        ...(detail === undefined ? {} : { detail: detail as never }),
      });
    const started = buildRowsOfItem("todo_list", todo("in_progress", "pending"));

    expect(readItems([...started, completion(todo("completed", "completed"))])[0]!.target).toBe(
      "2/2",
    );
    expect(readItems([...started, completion()])[0]!.target).toBe("0/2 · step 1");
    expect(readItems([...started, completion({ steps: 1 })])[0]!.target).toBe("0/2 · step 1");
  });

  it("draws a todo list as completed while it is open, and failed when it fails", () => {
    const failed = buildRowsOfItem("todo_list", todo("pending"), {
      _tag: "item.completed",
      status: "failed",
    });

    expect(readItems(failed)[0]!.result).toBe("failed");
  });

  it("draws a fetch as fetch with its URL, and a search as search with its query", () => {
    const fetched = buildRowsOfItem("web_search", {
      name: "WebFetch",
      input: { url: "https://example.com/a" },
      url: "https://example.com/a",
    });
    const searched = buildRowsOfItem("web_search", {
      name: "WebSearch",
      input: { query: "effect schema" },
      query: "effect schema",
    });
    const searchedByInputOnly = buildRowsOfItem("web_search", { input: { query: "codex" } });

    expect(readItems(fetched)[0]).toMatchObject({ verb: "fetch", target: "https://example.com/a" });
    expect(readItems(searched)[0]).toMatchObject({ verb: "search", target: "effect schema" });
    expect(readItems(searchedByInputOnly)[0]).toMatchObject({ verb: "search", target: "codex" });
  });

  it("names a call an MCP server made through the API connector <server>/<tool>", () => {
    const rows = buildRowsOfItem("tool_call", {
      name: "create_issue",
      input: {},
      kind: "mcp",
      server: "github",
    });

    expect(readItems(rows)[0]).toMatchObject({ verb: "tool", target: "github/create_issue" });
  });
});
