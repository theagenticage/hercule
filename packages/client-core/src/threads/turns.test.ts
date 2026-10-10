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

    const turns = buildTurns(rows, AGENT_ASKING_NOTHING);

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

    const turns = buildTurns(rows, AGENT_ASKING_NOTHING);

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

    const turns = buildTurns(rows, AGENT_ASKING_NOTHING);

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
    );

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
    );

    expect(turns[0]!.items[0]!.target).toBe("handlePaymentResult");
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
    );

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
    );
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
    );
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
    );
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
    );
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

    const turns = buildTurns(rows, AGENT_ASKING_NOTHING);

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
    );

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

    const turns = buildTurns(rows, AGENT_ASKING_NOTHING);

    expect(turns[0]!.items).toEqual([
      expect.objectContaining({ itemId: "edit4", verb: "edit", result: "failed" }),
      expect.objectContaining({ itemId: "tool4", verb: "tool", result: "declined" }),
    ]);
  });

  it("shows an item kind this build does not know as unknown, rather than crashing", () => {
    const novelKind = "image_generation" as unknown as ItemKindType;

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

    const turns = buildTurns(rows, AGENT_ASKING_NOTHING);

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

    const turns = buildTurns(rows, AGENT_ASKING_NOTHING);

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

    const turns = buildTurns(rows, AGENT_ASKING_NOTHING);

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

    const turns = buildTurns(rows, AGENT_ASKING_NOTHING);

    expect(turns).toHaveLength(1);
    expect(turns[0]!.userMessages).toEqual([
      { itemId: "u8a", text: "Fix the login bug", attachments: [], steered: false },
      {
        itemId: "u8b",
        text: "Also check auth.ts",
        attachments: [],
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
    const items = buildTurns(buildParkedRows(), buildAgentAskingAbout("tool9"))[0]!.items;

    expect(items.find((item) => item.itemId === "tool9")!.result).toBe("awaiting approval");
    expect(items.find((item) => item.itemId === "tool10")!.result).toBe("running");
  });

  it("marks the item of each open request as awaiting approval", () => {
    const items = buildTurns(buildParkedRows(), buildAgentAskingAbout("tool9", "tool10"))[0]!.items;

    expect(items.map((item) => item.result)).toEqual(["awaiting approval", "awaiting approval"]);
  });

  it("marks every open item as running when no request is open", () => {
    const items = buildTurns(buildParkedRows(), AGENT_ASKING_NOTHING)[0]!.items;

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
      buildTurns(rows, buildAgentAskingAbout("tool9"))[0]!.items.find(
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

    const [turn] = buildTurns(rows, AGENT_ASKING_NOTHING);

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

    const attachments = buildTurns(rows, AGENT_ASKING_NOTHING)[0]?.userMessages[0]?.attachments;
    expect(attachments).toEqual([]);
    // A memoized message compares its props by identity, so a fresh empty
    // list on each streamed row would draw it again for nothing.
    expect(buildTurns(rows, AGENT_ASKING_NOTHING)[0]?.userMessages[0]?.attachments).toBe(
      attachments,
    );
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
