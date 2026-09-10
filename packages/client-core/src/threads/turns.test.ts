/**
 * `turnsOf(rows)` groups a session's transcript rows into turns.
 *
 * Fixtures follow the Claude adapter's real shapes (spec 06 §6.3, and
 * `apps/runner/src/providers/claude-code.ts` / `claude-code-normalize.ts`):
 * a `user_message` item carries `detail: { text }` on both `item.started` and
 * `item.completed`; a tool item's `detail` on `item.started` is
 * `{ name, input, kind? }`; assistant text and reasoning arrive only on
 * `content.delta`, never on the `assistant_message` item events themselves.
 */
import { describe, expect, it } from "vitest";
import type { TranscriptRow } from "@hydra/contract";
import { turnsOf } from "./turns";

const SESSION_ID = "session-1";

let idSeq = 0;
const nextId = (): string => `e${idSeq++}`;

const row = (event: TranscriptRow["event"]): TranscriptRow => ({
  position: idSeq,
  at: event.at,
  event,
});

/** The `kind` an `item.started` row carries, narrowed off the row union. */
type ItemKindType = Extract<TranscriptRow["event"], { _tag: "item.started" }>["kind"];

describe("turnsOf", () => {
  it("groups rows into turns: the user message, ordered tool items, and the streamed assistant text", () => {
    const rows: TranscriptRow[] = [
      row({
        _tag: "turn.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:00.000Z",
        turnId: "t1",
      }),
      row({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:00.100Z",
        turnId: "t1",
        itemId: "u1",
        kind: "user_message",
        detail: { text: "Fix the login bug" },
      }),
      row({
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
      row({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:01.000Z",
        turnId: "t1",
        itemId: "tool1",
        kind: "command_execution",
        detail: { name: "Bash", input: { command: "ls -la" } },
      }),
      row({
        _tag: "content.delta",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:02.000Z",
        turnId: "t1",
        itemId: "a1",
        streamKind: "assistant_text",
        delta: "I'll ",
      }),
      row({
        _tag: "content.delta",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:02.500Z",
        turnId: "t1",
        itemId: "a1",
        streamKind: "assistant_text",
        delta: "look at the file.",
      }),
      row({
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
      row({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:03.500Z",
        turnId: "t1",
        itemId: "a1",
        kind: "assistant_message",
      }),
      row({
        _tag: "item.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:03.600Z",
        turnId: "t1",
        itemId: "a1",
        kind: "assistant_message",
        status: "completed",
      }),
      row({
        _tag: "turn.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:05.000Z",
        turnId: "t1",
        state: "completed",
      }),
      row({
        _tag: "turn.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:01:00.000Z",
        turnId: "t2",
      }),
      row({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:01:00.100Z",
        turnId: "t2",
        itemId: "u2",
        kind: "user_message",
        detail: { text: "What about the tests?" },
      }),
      row({
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
      row({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:01:01.000Z",
        turnId: "t2",
        itemId: "edit1",
        kind: "file_change",
        detail: { name: "Edit", input: { path: "src/auth.ts" } },
      }),
      row({
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
      row({
        _tag: "content.delta",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:01:02.000Z",
        turnId: "t2",
        itemId: "a2",
        streamKind: "assistant_text",
        delta: "Added a test too.",
      }),
      row({
        _tag: "turn.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:01:03.000Z",
        turnId: "t2",
        state: "completed",
      }),
    ];

    const turns = turnsOf(rows);

    expect(turns).toHaveLength(2);

    expect(turns[0]).toMatchObject({
      turnId: "t1",
      user: "Fix the login bug",
      assistantText: "I'll look at the file.",
      startedAt: "2026-09-08T10:00:00.000Z",
      duration: 5000,
    });
    // user_message and assistant_message never appear in `items`.
    expect(turns[0]!.items.map((item) => item.itemId)).toEqual(["tool1"]);
    expect(turns[0]!.items[0]).toMatchObject({
      itemId: "tool1",
      verb: "command",
      result: "completed",
    });
    // `target` is a one-line summary of a present `detail`.
    expect(turns[0]!.items[0]!.target).not.toBe("");
    expect(turns[0]!.items[0]!.target).not.toMatch(/\n/);

    expect(turns[1]).toMatchObject({
      turnId: "t2",
      user: "What about the tests?",
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
      row({
        _tag: "turn.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:00.000Z",
        turnId: "t1",
      }),
      row({
        _tag: "content.delta",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:01.000Z",
        turnId: "t1",
        itemId: "a1",
        streamKind: "assistant_text",
        delta: "Sleep 1 ",
      }),
      row({
        _tag: "content.delta",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:01.500Z",
        turnId: "t1",
        itemId: "a1",
        streamKind: "assistant_text",
        delta: "of 4 finished.",
      }),
      row({
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

    const turns = turnsOf(rows);

    expect(turns[0]!.assistantText).toBe("Sleep 1 of 4 finished.\n\nSleep 2 of 4 finished.");
  });

  it("summarizes a command item's target to the command it ran, not the row's raw JSON", () => {
    // The real Claude adapter's shape for a shell item (spec 06 §6.3's
    // command_execution): `{ name, input: { command, description } }`.
    const rows: TranscriptRow[] = [
      row({
        _tag: "turn.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:00.000Z",
        turnId: "t1",
      }),
      row({
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

    const turns = turnsOf(rows);

    expect(turns[0]!.items[0]!.target).toBe("ls -la");
  });

  it("falls back down summarize's chain: file_path, then description, then name, then raw JSON", () => {
    const fileChange = turnsOf([
      row({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:00.000Z",
        turnId: "t-path",
        itemId: "t-path",
        kind: "file_change",
        detail: { input: { file_path: "src/auth.ts" } },
      }),
    ]);
    expect(fileChange[0]!.items[0]!.target).toBe("src/auth.ts");

    const described = turnsOf([
      row({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:00.000Z",
        turnId: "t-desc",
        itemId: "t-desc",
        kind: "file_change",
        detail: { input: { description: "Search the web" } },
      }),
    ]);
    expect(described[0]!.items[0]!.target).toBe("Search the web");

    const named = turnsOf([
      row({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:00.000Z",
        turnId: "t-name",
        itemId: "t-name",
        kind: "file_change",
        detail: { name: "some_mcp_tool" },
      }),
    ]);
    expect(named[0]!.items[0]!.target).toBe("some_mcp_tool");

    const bare = turnsOf([
      row({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T10:00:00.000Z",
        turnId: "t-json",
        itemId: "t-json",
        kind: "file_change",
        detail: { foo: "bar" },
      }),
    ]);
    expect(bare[0]!.items[0]!.target).toBe(JSON.stringify({ foo: "bar" }));
  });

  it("leaves duration null and marks the still-open item running while a turn has no turn.completed yet", () => {
    const rows: TranscriptRow[] = [
      row({
        _tag: "turn.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T11:00:00.000Z",
        turnId: "t3",
      }),
      row({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T11:00:00.100Z",
        turnId: "t3",
        itemId: "u3",
        kind: "user_message",
        detail: { text: "Run the tests" },
      }),
      row({
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
      row({
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

    const turns = turnsOf(rows);

    expect(turns).toHaveLength(1);
    expect(turns[0]!.duration).toBeNull();
    expect(turns[0]!.items).toEqual([
      expect.objectContaining({ itemId: "tool3", result: "running" }),
    ]);
  });

  it("carries a failed or declined item.completed status through as the item's result", () => {
    const rows: TranscriptRow[] = [
      row({
        _tag: "turn.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T12:00:00.000Z",
        turnId: "t4",
      }),
      row({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T12:00:00.500Z",
        turnId: "t4",
        itemId: "edit4",
        kind: "file_change",
        detail: { name: "Edit", input: { path: "src/broken.ts" } },
      }),
      row({
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
      row({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T12:00:01.500Z",
        turnId: "t4",
        itemId: "tool4",
        kind: "tool_call",
        detail: { name: "mcp__example__do_thing", input: {}, kind: "mcp" },
      }),
      row({
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
      row({
        _tag: "turn.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T12:00:02.500Z",
        turnId: "t4",
        state: "completed",
      }),
    ];

    const turns = turnsOf(rows);

    expect(turns[0]!.items).toEqual([
      expect.objectContaining({ itemId: "edit4", verb: "edit", result: "failed" }),
      expect.objectContaining({ itemId: "tool4", verb: "tool", result: "declined" }),
    ]);
  });

  it("renders an item kind outside this build's vocabulary as unknown, generically rather than crashing", () => {
    const novelKind = "image_generation" as unknown as ItemKindType;

    const rows: TranscriptRow[] = [
      row({
        _tag: "turn.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T13:00:00.000Z",
        turnId: "t5",
      }),
      row({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T13:00:00.500Z",
        turnId: "t5",
        itemId: "novel1",
        // A kind this build's vocabulary has never heard of, forced past the
        // type to simulate a future harness emitting something unmapped
        // (spec 06: "Enums are open for consumers: unknown kinds render
        // generically, never crash").
        kind: novelKind,
        detail: { note: "review mode" },
      }),
      row({
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
      row({
        _tag: "turn.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T13:00:01.500Z",
        turnId: "t5",
        state: "completed",
      }),
    ];

    const turns = turnsOf(rows);

    expect(turns[0]!.items).toEqual([
      expect.objectContaining({ itemId: "novel1", verb: "unknown" }),
    ]);
  });

  it("has an empty items array when a turn holds only the user and assistant messages", () => {
    const rows: TranscriptRow[] = [
      row({
        _tag: "turn.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T14:00:00.000Z",
        turnId: "t6",
      }),
      row({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T14:00:00.100Z",
        turnId: "t6",
        itemId: "u6",
        kind: "user_message",
        detail: { text: "Say hi" },
      }),
      row({
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
      row({
        _tag: "content.delta",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T14:00:00.500Z",
        turnId: "t6",
        itemId: "a6",
        streamKind: "assistant_text",
        delta: "Hi!",
      }),
      row({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T14:00:00.600Z",
        turnId: "t6",
        itemId: "a6",
        kind: "assistant_message",
      }),
      row({
        _tag: "item.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T14:00:00.700Z",
        turnId: "t6",
        itemId: "a6",
        kind: "assistant_message",
        status: "completed",
      }),
      row({
        _tag: "turn.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T14:00:01.000Z",
        turnId: "t6",
        state: "completed",
      }),
    ];

    const turns = turnsOf(rows);

    expect(turns[0]!.items).toEqual([]);
    expect(turns[0]!.assistantText).toBe("Hi!");
  });

  it("renders target as the empty string when item.started carries no detail at all", () => {
    const rows: TranscriptRow[] = [
      row({
        _tag: "turn.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T15:00:00.000Z",
        turnId: "t7",
      }),
      row({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T15:00:00.500Z",
        turnId: "t7",
        itemId: "tool7",
        kind: "tool_call",
        // no `detail`
      }),
      row({
        _tag: "item.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T15:00:01.000Z",
        turnId: "t7",
        itemId: "tool7",
        kind: "tool_call",
        status: "completed",
      }),
      row({
        _tag: "turn.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T15:00:01.500Z",
        turnId: "t7",
        state: "completed",
      }),
    ];

    const turns = turnsOf(rows);

    expect(turns[0]!.items[0]!.target).toBe("");
  });

  it("keeps the opening prompt when a steered input adds a second user_message to the same turn", () => {
    const rows: TranscriptRow[] = [
      row({
        _tag: "turn.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T16:00:00.000Z",
        turnId: "t8",
      }),
      row({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T16:00:00.100Z",
        turnId: "t8",
        itemId: "u8a",
        kind: "user_message",
        detail: { text: "Fix the login bug" },
      }),
      row({
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
      // A steered input folds into the same running turn as a second
      // user_message, rather than opening a turn of its own.
      row({
        _tag: "item.started",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T16:00:01.000Z",
        turnId: "t8",
        itemId: "u8b",
        kind: "user_message",
        detail: { text: "Also check auth.ts", steered: true },
      }),
      row({
        _tag: "item.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T16:00:01.000Z",
        turnId: "t8",
        itemId: "u8b",
        kind: "user_message",
        status: "completed",
        detail: { text: "Also check auth.ts", steered: true },
      }),
      row({
        _tag: "turn.completed",
        eventId: nextId(),
        sessionId: SESSION_ID,
        at: "2026-09-08T16:00:02.000Z",
        turnId: "t8",
        state: "completed",
      }),
    ];

    const turns = turnsOf(rows);

    expect(turns[0]!.user).toContain("Fix the login bug");
    expect(turns[0]!.user).toContain("Also check auth.ts");
  });
});
