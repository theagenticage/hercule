/**
 * Tests the functions that build an assistant's Conversation as the desktop
 * draws it:
 *
 * - `trimToRunningTurn(rows)` drops the rows before the running turn as rows
 *   stream in.
 * - `collectRunningTurnRows(rowsNewestFirst)` keeps the rows of the session's
 *   running turn from the rows read so far.
 * - `decideOpenReply(input)` decides the reply the assistant is writing, as
 *   far as no stored message holds it, by the rules the controller stores
 *   replies by.
 * - `describeOpenReply(block)` returns the words beside the open reply's
 *   name.
 * - `buildConversationBlocks(input)` lays out the day stamps, the stored
 *   messages and the open reply.
 *
 * The transcript fixtures follow the adapters' real shapes: an assistant
 * text's words arrive only in `content.delta` rows. Every time is in UTC, and
 * now is 12:00 on 7 October 2026.
 */
import { describe, expect, it } from "vitest";
import type { ConversationMessage, TranscriptRow } from "@hercule/contract";
import { buildSession } from "../threads/workspaces.testing";
import {
  buildConversationBlocks,
  collectRunningTurnRows,
  decideOpenReply,
  describeOpenReply,
  trimToRunningTurn,
  type ConversationBlock,
  type OpenReplyBlock,
} from "./conversation-blocks";

type ProviderEvent = TranscriptRow["event"];
type ItemKind = Extract<ProviderEvent, { _tag: "item.started" }>["kind"];

const NOW = new Date("2026-10-07T12:00:00.000Z");
const TODAY = "2026-10-07T09:00:00.000Z";

const BUSY = buildSession({ id: "s1", status: "busy", conversationId: "c1" });
const IDLE = buildSession({ id: "s1", status: "idle", conversationId: "c1" });

let position = 0;

/** Wraps an event in a transcript row at the next position. */
const buildRow = (event: ProviderEvent): TranscriptRow => ({
  position: ++position,
  at: event.at,
  event,
});

/** Returns the fields every event carries. */
const buildEnvelope = () => ({ eventId: `e${String(position)}`, sessionId: "s1", at: TODAY });

const buildTurnStarted = (turnId: string): TranscriptRow =>
  buildRow({ _tag: "turn.started", ...buildEnvelope(), turnId });

const buildTurnCompleted = (
  turnId: string,
  state: "completed" | "failed" | "interrupted" = "completed",
): TranscriptRow => buildRow({ _tag: "turn.completed", ...buildEnvelope(), turnId, state });

const buildItemStarted = (
  turnId: string,
  itemId: string,
  kind: ItemKind = "assistant_message",
): TranscriptRow => buildRow({ _tag: "item.started", ...buildEnvelope(), turnId, itemId, kind });

const buildItemCompleted = (
  turnId: string,
  itemId: string,
  status: "completed" | "failed" | "declined" = "completed",
  kind: ItemKind = "assistant_message",
): TranscriptRow =>
  buildRow({ _tag: "item.completed", ...buildEnvelope(), turnId, itemId, kind, status });

const buildText = (turnId: string, itemId: string, delta: string): TranscriptRow =>
  buildRow({
    _tag: "content.delta",
    ...buildEnvelope(),
    turnId,
    itemId,
    streamKind: "assistant_text",
    delta,
  });

const buildSessionExited = (): TranscriptRow =>
  buildRow({ _tag: "session.exited", ...buildEnvelope(), reason: "crash" });

const buildSessionStarted = (): TranscriptRow =>
  buildRow({ _tag: "session.started", ...buildEnvelope() });

/** Returns the rows of a whole assistant text: its start, its words, and its end. */
const buildAssistantText = (turnId: string, itemId: string, text: string): TranscriptRow[] => [
  buildItemStarted(turnId, itemId),
  buildText(turnId, itemId, text),
  buildItemCompleted(turnId, itemId),
];

/** Returns the rows of a tool call that has started and not completed. */
const buildRunningTool = (turnId: string, itemId: string): TranscriptRow =>
  buildItemStarted(turnId, itemId, "command_execution");

let messagePosition = 0;

/** Builds the next stored message of the Conversation. */
const buildMessage = (
  senderRole: ConversationMessage["senderRole"],
  over: Partial<ConversationMessage> = {},
): ConversationMessage => {
  messagePosition += 1;
  return {
    id: `m${String(messagePosition)}`,
    conversationId: "c1",
    containerKey: null,
    position: messagePosition,
    senderRole,
    senderLabel: senderRole === "owner" ? "rogier" : "Ada",
    text: `message ${String(messagePosition)}`,
    sessionId: senderRole === "owner" ? null : "s1",
    turnId: null,
    itemId: null,
    actor: senderRole === "owner" ? "user" : "session:s1",
    createdAt: TODAY,
    ...over,
  };
};

/**
 * Builds a reply the controller stores for `turnId` that holds the assistant
 * text `itemId`, or, with `itemId` null, the turn's texts joined.
 */
const buildReply = (turnId: string, itemId: string | null, text = "stored"): ConversationMessage =>
  buildMessage("assistant", { turnId, itemId, text });

/** Returns the open reply's shown items as "<itemId>:<rowText>". */
const describeItems = (items: readonly { itemId: string; rowText: string }[]) =>
  items.map(({ itemId, rowText }) => `${itemId}:${rowText}`);

/** Decides the open reply with the defaults most tests share. */
const decide = (
  over: Partial<Parameters<typeof decideOpenReply>[0]> = {},
): ReturnType<typeof decideOpenReply> =>
  decideOpenReply({
    messages: [],
    runningTurnRows: [],
    session: BUSY,
    reply: "turn-end",
    pose: "working",
    ...over,
  });

/** Builds the blocks with the defaults most tests share. */
const build = (
  over: Partial<Parameters<typeof buildConversationBlocks>[0]> = {},
): readonly ConversationBlock[] =>
  buildConversationBlocks({
    messages: [],
    runningTurnRows: [],
    session: IDLE,
    reply: "turn-end",
    pose: "idle",
    timezone: "UTC",
    now: NOW,
    ...over,
  });

/** Returns each block as its kind and, for a stamp, its label. */
const describeBlocks = (blocks: readonly ConversationBlock[]) =>
  blocks.map((block) => (block.kind === "stamp" ? `stamp ${block.label}` : block.kind));

describe("trimToRunningTurn", () => {
  it("drops the rows before the newest turn.started", () => {
    const older = [buildTurnStarted("t0"), ...buildAssistantText("t0", "a0", "old")];
    const ended = buildTurnCompleted("t0");
    const running = [buildTurnStarted("t1"), buildItemStarted("t1", "a1")];

    expect(trimToRunningTurn([...older, ended, ...running])).toEqual(running);
  });

  it("returns the rows themselves when they start with the newest turn.started", () => {
    const rows = [buildTurnStarted("t1"), buildItemStarted("t1", "a1")];

    expect(trimToRunningTurn(rows)).toBe(rows);
  });

  it("returns the rows themselves when they hold no turn.started", () => {
    const rows = [buildItemStarted("t1", "a1"), buildText("t1", "a1", "hi")];

    expect(trimToRunningTurn(rows)).toBe(rows);
  });
});

describe("collectRunningTurnRows", () => {
  it("keeps the rows from the newest turn.started on, oldest first", () => {
    const older = [buildTurnStarted("t0"), ...buildAssistantText("t0", "a0", "old")];
    const running = [
      buildTurnStarted("t1"),
      buildItemStarted("t1", "a1"),
      buildText("t1", "a1", "hi"),
    ];
    const newestFirst = [...older, ...running].reverse();

    expect(collectRunningTurnRows(newestFirst)).toEqual({ reachedTurnStart: true, rows: running });
  });

  it("keeps a turn's end that sits above its start", () => {
    const rows = [
      buildTurnStarted("t1"),
      ...buildAssistantText("t1", "a1", "hi"),
      buildTurnCompleted("t1"),
    ];

    expect(collectRunningTurnRows([...rows].reverse())).toEqual({ reachedTurnStart: true, rows });
  });

  it("keeps every row read, oldest first, before a turn.started is reached", () => {
    const rows = [buildItemStarted("t1", "a1"), buildText("t1", "a1", "hi")];

    expect(collectRunningTurnRows([...rows].reverse())).toEqual({ reachedTurnStart: false, rows });
  });

  it("reaches no turn start in no rows", () => {
    expect(collectRunningTurnRows([])).toEqual({ reachedTurnStart: false, rows: [] });
  });
});

describe("decideOpenReply in turn-end mode", () => {
  it("shows the text being written, with its id as the open item", () => {
    const rows = [
      buildTurnStarted("t1"),
      buildItemStarted("t1", "a1"),
      buildText("t1", "a1", "Look"),
    ];

    const reply = decide({ runningTurnRows: rows });

    expect(reply).toMatchObject({
      key: "open-reply",
      turnId: "t1",
      openItemId: "a1",
      pose: "working",
    });
    expect(describeItems(reply?.items ?? [])).toEqual(["a1:Look"]);
  });

  it("shows a text whose words came before its start", () => {
    const rows = [
      buildTurnStarted("t1"),
      buildText("t1", "a1", "Look"),
      buildItemStarted("t1", "a1"),
    ];

    expect(describeItems(decide({ runningTurnRows: rows })?.items ?? [])).toEqual(["a1:Look"]);
  });

  it("puts the turn's second text in the first one's place", () => {
    const rows = [
      buildTurnStarted("t1"),
      ...buildAssistantText("t1", "a1", "Let me look."),
      buildItemStarted("t1", "tool1", "command_execution"),
      buildItemCompleted("t1", "tool1", "completed", "command_execution"),
      buildItemStarted("t1", "a2"),
      buildText("t1", "a2", "Found"),
    ];

    const reply = decide({ runningTurnRows: rows });

    expect(describeItems(reply?.items ?? [])).toEqual(["a2:Found"]);
    expect(reply?.openItemId).toBe("a2");
  });

  it("keeps the first text while a tool runs after it, with no open item", () => {
    const rows = [
      buildTurnStarted("t1"),
      ...buildAssistantText("t1", "a1", "Let me look."),
      buildRunningTool("t1", "tool1"),
    ];

    const reply = decide({ runningTurnRows: rows });

    expect(describeItems(reply?.items ?? [])).toEqual(["a1:Let me look."]);
    expect(reply?.openItemId).toBeNull();
  });

  it("keeps the last text after the turn ends, until its reply is stored", () => {
    const rows = [
      buildTurnStarted("t1"),
      ...buildAssistantText("t1", "a1", "Done."),
      buildTurnCompleted("t1"),
    ];

    const waiting = decide({ runningTurnRows: rows, session: IDLE });
    expect(describeItems(waiting?.items ?? [])).toEqual(["a1:Done."]);
    expect(waiting?.openItemId).toBeNull();

    expect(
      decide({ runningTurnRows: rows, session: IDLE, messages: [buildReply("t1", "a1")] }),
    ).toBeNull();
  });

  it("hides the stored text before the turn's end arrives, and shows the caret until it does", () => {
    // A stored reply that holds one text does not end the turn: it may be a
    // segment stored before the reply mode changed to turn-end, while the
    // turn still runs. Only the turn's end row ends it.
    const rows = [buildTurnStarted("t1"), ...buildAssistantText("t1", "a1", "Done.")];
    const messages = [buildReply("t1", "a1")];

    expect(decide({ runningTurnRows: rows, messages })).toMatchObject({
      turnId: "t1",
      items: [],
      openItemId: null,
    });
    const ended = [...rows, buildTurnCompleted("t1")];
    expect(decide({ runningTurnRows: ended, messages })).toBeNull();
  });

  it("shows the text being written after segments stored before the mode changed", () => {
    const rows = [
      buildTurnStarted("t1"),
      ...buildAssistantText("t1", "a1", "First."),
      ...buildAssistantText("t1", "a2", "Second."),
      buildItemStarted("t1", "a3"),
      buildText("t1", "a3", "Thi"),
    ];
    const messages = [buildReply("t1", "a1", "First."), buildReply("t1", "a2", "Second.")];

    const reply = decide({ runningTurnRows: rows, messages });

    expect(describeItems(reply?.items ?? [])).toEqual(["a3:Thi"]);
    expect(reply?.openItemId).toBe("a3");
  });

  it("ignores a stored reply of another turn", () => {
    const rows = [buildTurnStarted("t2"), ...buildAssistantText("t2", "a2", "Again.")];

    const reply = decide({ runningTurnRows: rows, messages: [buildReply("t1", "a2")] });

    expect(describeItems(reply?.items ?? [])).toEqual(["a2:Again."]);
  });

  it("shows nothing for a turn that ended with an empty last text", () => {
    const rows = [
      buildTurnStarted("t1"),
      ...buildAssistantText("t1", "a1", ""),
      buildTurnCompleted("t1"),
    ];

    expect(decide({ runningTurnRows: rows, session: IDLE })).toBeNull();
  });

  it("ignores the texts of the turn before the running one", () => {
    const rows = [
      buildTurnStarted("t0"),
      ...buildAssistantText("t0", "a0", "Old answer."),
      buildTurnCompleted("t0"),
      buildTurnStarted("t1"),
    ];

    expect(decide({ runningTurnRows: rows })?.items).toEqual([]);
  });

  it("keeps the last text that holds text when a later text completes empty", () => {
    const rows = [
      buildTurnStarted("t1"),
      ...buildAssistantText("t1", "a1", "Answer."),
      buildItemStarted("t1", "a2"),
      buildItemCompleted("t1", "a2"),
    ];

    expect(describeItems(decide({ runningTurnRows: rows })?.items ?? [])).toEqual(["a1:Answer."]);
    const ended = [...rows, buildTurnCompleted("t1")];
    expect(describeItems(decide({ runningTurnRows: ended, session: IDLE })?.items ?? [])).toEqual([
      "a1:Answer.",
    ]);
  });

  it("shows the text whose first text row came last, as the controller stores it", () => {
    // The controller holds a text's words until it completes, so a2's words
    // land before a1's here, and a1's are the last the controller reads.
    const rows = [
      buildTurnStarted("t1"),
      buildItemStarted("t1", "a1"),
      buildItemStarted("t1", "a2"),
      buildText("t1", "a2", "Second."),
      buildItemCompleted("t1", "a2"),
      buildText("t1", "a1", "First."),
      buildItemCompleted("t1", "a1"),
      buildTurnCompleted("t1"),
    ];

    expect(describeItems(decide({ runningTurnRows: rows, session: IDLE })?.items ?? [])).toEqual([
      "a1:First.",
    ]);
  });

  it("skips text rows that name another turn", () => {
    const rows = [
      buildTurnStarted("t1"),
      buildItemStarted("t1", "a1"),
      buildText("t1", "a1", "Mine."),
      buildText("t0", "a1", " Not mine."),
    ];

    expect(describeItems(decide({ runningTurnRows: rows })?.items ?? [])).toEqual(["a1:Mine."]);
  });

  it("shows every text that holds text after a failed turn, as the controller joins them", () => {
    const rows = [
      buildTurnStarted("t1"),
      ...buildAssistantText("t1", "a1", "First."),
      ...buildAssistantText("t1", "a2", ""),
      buildItemStarted("t1", "a3"),
      buildText("t1", "a3", "Half"),
      buildTurnCompleted("t1", "failed"),
    ];

    const reply = decide({ runningTurnRows: rows, session: IDLE });

    expect(describeItems(reply?.items ?? [])).toEqual(["a1:First.", "a3:Half"]);
    expect(reply?.openItemId).toBeNull();
  });

  it("shows nothing once the joined reply of a stopped turn is stored", () => {
    const rows = [
      buildTurnStarted("t1"),
      ...buildAssistantText("t1", "a1", "First."),
      buildItemStarted("t1", "a2"),
      buildText("t1", "a2", "Half"),
      buildTurnCompleted("t1", "interrupted"),
    ];
    const messages = [buildReply("t1", null, "First.\n\nHalf")];

    expect(decide({ runningTurnRows: rows, messages })).toBeNull();
    expect(decide({ runningTurnRows: rows, messages, session: IDLE })).toBeNull();
  });

  it("ends the turn at its joined reply, even before the turn's end arrives", () => {
    const rows = [
      buildTurnStarted("t1"),
      buildItemStarted("t1", "a1"),
      buildText("t1", "a1", "Half"),
    ];

    expect(
      decide({ runningTurnRows: rows, messages: [buildReply("t1", null, "Half")] }),
    ).toBeNull();
  });

  it("shows nothing under the notice when the session exited mid-turn", () => {
    const rows = [
      buildTurnStarted("t1"),
      buildItemStarted("t1", "a1"),
      buildText("t1", "a1", "Half"),
      buildSessionExited(),
    ];

    expect(decide({ runningTurnRows: rows })).toBeNull();
    expect(decide({ runningTurnRows: rows, session: IDLE })).toBeNull();
  });

  it("shows nothing when the session started again mid-turn", () => {
    const rows = [
      buildTurnStarted("t1"),
      ...buildAssistantText("t1", "a1", "Lost."),
      buildSessionStarted(),
    ];

    expect(decide({ runningTurnRows: rows })).toBeNull();
  });
});

describe("decideOpenReply in segments mode", () => {
  const segments = { reply: "segments" } as const;

  it("shows the texts after the ones already stored", () => {
    const rows = [
      buildTurnStarted("t1"),
      ...buildAssistantText("t1", "a1", "First."),
      ...buildAssistantText("t1", "a2", "Second."),
    ];

    const reply = decide({
      ...segments,
      runningTurnRows: rows,
      messages: [buildReply("t1", "a1")],
    });

    expect(describeItems(reply?.items ?? [])).toEqual(["a2:Second."]);
  });

  it("shows every text not stored yet, the one being written last", () => {
    const rows = [
      buildTurnStarted("t1"),
      ...buildAssistantText("t1", "a1", "First."),
      buildItemStarted("t1", "a2"),
      buildText("t1", "a2", "Sec"),
    ];

    const reply = decide({ ...segments, runningTurnRows: rows });

    expect(describeItems(reply?.items ?? [])).toEqual(["a1:First.", "a2:Sec"]);
    expect(reply?.openItemId).toBe("a2");
  });

  it("hides the texts that completed before a stored one, as the controller stored them first", () => {
    const rows = [
      buildTurnStarted("t1"),
      buildItemStarted("t1", "a1"),
      buildText("t1", "a1", "First."),
      buildItemStarted("t1", "a2"),
      buildText("t1", "a2", "Second."),
      buildItemCompleted("t1", "a2"),
      buildItemCompleted("t1", "a1"),
    ];

    const first = decide({
      ...segments,
      runningTurnRows: rows,
      messages: [buildReply("t1", "a2")],
    });
    expect(describeItems(first?.items ?? [])).toEqual(["a1:First."]);

    // a1 completed after a2, so a stored a1 means a2 was stored before it.
    const both = decide({ ...segments, runningTurnRows: rows, messages: [buildReply("t1", "a1")] });
    expect(both).toMatchObject({ items: [] });
  });

  it("shows no text of a turn whose first replies are on a page not read yet", () => {
    // The newest page holds 50 messages: the replies for a2 to a51. The reply
    // for a1 is on the page before it.
    const texts = Array.from({ length: 51 }, (_, index) => `a${String(index + 1)}`);
    const rows = [
      buildTurnStarted("t1"),
      ...texts.flatMap((itemId) => buildAssistantText("t1", itemId, `Text ${itemId}.`)),
    ];
    const messages = texts.slice(1).map((itemId) => buildReply("t1", itemId, `Text ${itemId}.`));

    expect(decide({ ...segments, runningTurnRows: rows, messages })).toMatchObject({ items: [] });
    const ended = [...rows, buildTurnCompleted("t1")];
    expect(decide({ ...segments, runningTurnRows: ended, messages, session: IDLE })).toBeNull();
  });

  it("never shows a text the controller will not store", () => {
    const rows = [
      buildTurnStarted("t1"),
      buildItemStarted("t1", "a1"),
      buildText("t1", "a1", "Half"),
      buildItemCompleted("t1", "a1", "failed"),
      ...buildAssistantText("t1", "a2", ""),
      ...buildAssistantText("t1", "a3", "Third."),
    ];

    const reply = decide({ ...segments, runningTurnRows: rows });

    expect(describeItems(reply?.items ?? [])).toEqual(["a3:Third."]);
  });

  it("drops a text the turn's end cut off, which is never stored", () => {
    const rows = [
      buildTurnStarted("t1"),
      ...buildAssistantText("t1", "a1", "First."),
      buildItemStarted("t1", "a2"),
      buildText("t1", "a2", "Cut"),
      buildTurnCompleted("t1", "interrupted"),
    ];

    expect(
      decide({
        ...segments,
        runningTurnRows: rows,
        session: IDLE,
        messages: [buildReply("t1", "a1")],
      }),
    ).toBeNull();
  });

  it("skips text rows before the text's start, as the controller does", () => {
    const rows = [
      buildTurnStarted("t1"),
      buildText("t1", "a1", "Early "),
      buildItemStarted("t1", "a1"),
      buildText("t1", "a1", "Late."),
      buildItemCompleted("t1", "a1"),
    ];

    expect(describeItems(decide({ ...segments, runningTurnRows: rows })?.items ?? [])).toEqual([
      "a1:Late.",
    ]);
  });

  it("never shows a text with no start, which the controller never stores", () => {
    const rows = [
      buildTurnStarted("t1"),
      buildText("t1", "a1", "Orphan."),
      buildItemCompleted("t1", "a1"),
    ];

    expect(decide({ ...segments, runningTurnRows: rows })).toMatchObject({ items: [] });
  });

  it("shows nothing under the notice when the session exited mid-text", () => {
    const rows = [
      buildTurnStarted("t1"),
      ...buildAssistantText("t1", "a1", "Stored."),
      buildItemStarted("t1", "a2"),
      buildText("t1", "a2", "Half"),
      buildSessionExited(),
    ];

    expect(
      decide({ ...segments, runningTurnRows: rows, messages: [buildReply("t1", "a1", "Stored.")] }),
    ).toBeNull();
  });

  it("shows the caret alone once every text is stored and the turn still runs", () => {
    const rows = [
      buildTurnStarted("t1"),
      ...buildAssistantText("t1", "a1", "First."),
      buildRunningTool("t1", "tool1"),
    ];

    const reply = decide({
      ...segments,
      runningTurnRows: rows,
      messages: [buildReply("t1", "a1")],
    });

    expect(reply).toMatchObject({ key: "open-reply", items: [], openItemId: null });
  });
});

describe("decideOpenReply with no text to show", () => {
  it("shows the caret alone while the session is busy and the turn has no text yet", () => {
    const rows = [buildTurnStarted("t1"), buildRunningTool("t1", "tool1")];

    expect(decide({ runningTurnRows: rows })).toEqual({
      kind: "open-reply",
      key: "open-reply",
      turnId: "t1",
      items: [],
      openItemId: null,
      pose: "working",
    });
  });

  it("shows the caret alone, in the pose given, while a Request is open", () => {
    const rows = [buildTurnStarted("t1"), buildRunningTool("t1", "tool1")];

    expect(decide({ runningTurnRows: rows, pose: "waiting" })?.pose).toBe("waiting");
  });

  it("shows the caret alone before the running turn's first row arrives", () => {
    expect(decide()).toMatchObject({ key: "open-reply", turnId: null, items: [] });
  });

  it("shows nothing when the session is not busy and nothing is left to show", () => {
    expect(decide({ session: IDLE })).toBeNull();
    expect(decide({ session: null })).toBeNull();
  });

  it("shows nothing for a turn that ended with no text, while the session still reads busy", () => {
    const rows = [buildTurnStarted("t1"), buildTurnCompleted("t1")];

    expect(decide({ runningTurnRows: rows })).toBeNull();
  });
});

describe("decideOpenReply after the owner sends the next message", () => {
  const LATER = "2026-10-07T09:10:00.000Z";
  const NEXT_TURN_CARET = {
    kind: "open-reply",
    key: "open-reply",
    turnId: null,
    items: [],
    openItemId: null,
    pose: "working",
  };

  it("shows the caret alone for the next turn once the last turn completed (turn-end)", () => {
    const rows = [
      buildTurnStarted("t1"),
      ...buildAssistantText("t1", "a1", "Done."),
      buildTurnCompleted("t1"),
    ];
    const messages = [
      buildMessage("owner"),
      buildReply("t1", "a1", "Done."),
      buildMessage("owner", { createdAt: LATER }),
    ];

    expect(decide({ runningTurnRows: rows, messages })).toEqual(NEXT_TURN_CARET);
  });

  it("shows the caret alone when the joined reply ended the turn before its end row", () => {
    const rows = [
      buildTurnStarted("t1"),
      buildItemStarted("t1", "a1"),
      buildText("t1", "a1", "Half"),
    ];
    const messages = [buildMessage("owner"), buildReply("t1", null, "Half"), buildMessage("owner")];

    expect(decide({ runningTurnRows: rows, messages })).toEqual(NEXT_TURN_CARET);
  });

  it("shows the running turn's caret when a single-text reply arrived before the end row", () => {
    // The stored reply does not end the turn, so the caret still stands for
    // it until the turn's end row arrives.
    const rows = [buildTurnStarted("t1"), ...buildAssistantText("t1", "a1", "Done.")];
    const messages = [
      buildMessage("owner"),
      buildReply("t1", "a1", "Done."),
      buildMessage("owner"),
    ];

    expect(decide({ runningTurnRows: rows, messages })).toEqual({
      ...NEXT_TURN_CARET,
      turnId: "t1",
    });
  });

  it("shows the caret alone for the next turn once the last turn completed (segments)", () => {
    const rows = [
      buildTurnStarted("t1"),
      ...buildAssistantText("t1", "a1", "Done."),
      buildTurnCompleted("t1"),
    ];
    const messages = [buildReply("t1", "a1", "Done."), buildMessage("owner", { createdAt: LATER })];

    expect(decide({ reply: "segments", runningTurnRows: rows, messages })).toEqual(NEXT_TURN_CARET);
  });

  it("shows the caret for the next turn rather than the ended turn's text not stored yet", () => {
    const rows = [
      buildTurnStarted("t1"),
      ...buildAssistantText("t1", "a1", "Done."),
      buildTurnCompleted("t1"),
    ];
    const messages = [buildMessage("owner", { createdAt: LATER })];

    expect(decide({ reply: "segments", runningTurnRows: rows, messages })).toEqual(NEXT_TURN_CARET);
  });

  it("shows nothing for an owner message sent before the turn ended, while busy reads stale", () => {
    const rows = [
      buildTurnStarted("t1"),
      ...buildAssistantText("t1", "a1", "Done."),
      buildTurnCompleted("t1"),
    ];
    const messages = [buildMessage("owner"), buildReply("t1", "a1", "Done.")];

    expect(decide({ runningTurnRows: rows, messages })).toBeNull();
    expect(decide({ reply: "segments", runningTurnRows: rows, messages })).toBeNull();
  });

  it("shows nothing for an owner message after the end while the session is not busy", () => {
    const rows = [buildTurnStarted("t1"), buildTurnCompleted("t1")];
    const messages = [buildMessage("owner", { createdAt: LATER })];

    expect(decide({ runningTurnRows: rows, messages, session: IDLE })).toBeNull();
  });
});

describe("buildConversationBlocks", () => {
  it("returns no blocks for an empty Conversation", () => {
    expect(build()).toEqual([]);
  });

  it("returns a block per stored message, by its sender, with its time", () => {
    const owner = buildMessage("owner");
    const reply = buildReply("t1", "a1");
    const notice = buildMessage("notice", { createdAt: "2026-10-07T09:05:00.000Z" });

    expect(build({ messages: [owner, reply, notice] })).toEqual([
      { kind: "stamp", key: "stamp:Today", label: "Today" },
      { kind: "owner", key: `message:${owner.id}`, message: owner, time: "09:00" },
      { kind: "reply", key: `message:${reply.id}`, message: reply, time: "09:00" },
      { kind: "notice", key: `message:${notice.id}`, message: notice, time: "09:05" },
    ]);
  });

  it("puts a day stamp above the first message of each day, across years", () => {
    const messages = [
      buildMessage("owner", { createdAt: "2025-12-31T09:00:00.000Z" }),
      buildMessage("owner", { createdAt: "2026-09-04T09:00:00.000Z" }),
      buildMessage("assistant", { createdAt: "2026-09-04T09:01:00.000Z" }),
      buildMessage("owner", { createdAt: "2026-10-06T23:00:00.000Z" }),
      buildMessage("owner", { createdAt: "2026-10-07T00:10:00.000Z" }),
    ];

    const blocks = build({ messages });

    expect(describeBlocks(blocks)).toEqual([
      "stamp 31 Dec 2025",
      "owner",
      "stamp 4 Sep",
      "owner",
      "reply",
      "stamp Yesterday",
      "owner",
      "stamp Today",
      "owner",
    ]);
    expect(blocks.map((block) => (block.kind === "owner" ? block.time : null))).toContain(
      "31 Dec 09:00",
    );
  });

  it("reads the days in the given time zone", () => {
    // 23:00 UTC on the 6th is already the 7th in Amsterdam.
    const messages = [buildMessage("owner", { createdAt: "2026-10-06T23:00:00.000Z" })];

    expect(describeBlocks(build({ messages, timezone: "Europe/Amsterdam" }))).toEqual([
      "stamp Today",
      "owner",
    ]);
  });

  it("puts the open reply last, after a message the owner steered in", () => {
    const rows = [
      buildTurnStarted("t1"),
      buildItemStarted("t1", "a1"),
      buildText("t1", "a1", "Lo"),
    ];
    const messages = [buildMessage("owner"), buildMessage("owner")];

    const blocks = build({ messages, runningTurnRows: rows, session: BUSY, pose: "working" });

    expect(describeBlocks(blocks)).toEqual(["stamp Today", "owner", "owner", "open-reply"]);
  });

  it("puts a Today stamp above the open reply when no message was stored today", () => {
    const messages = [buildMessage("owner", { createdAt: "2026-10-06T09:00:00.000Z" })];

    const blocks = build({ messages, session: BUSY });

    expect(describeBlocks(blocks)).toEqual([
      "stamp Yesterday",
      "owner",
      "stamp Today",
      "open-reply",
    ]);
  });

  it("keeps a day stamp's key when earlier messages of its day are added", () => {
    const later = buildMessage("owner", { createdAt: "2026-10-07T09:30:00.000Z" });
    const earlier = buildMessage("owner", { createdAt: "2026-10-07T08:00:00.000Z" });

    expect(build({ messages: [later] })[0]?.key).toBe("stamp:Today");
    expect(build({ messages: [earlier, later] })[0]?.key).toBe("stamp:Today");
  });

  it("shows the stored partial reply and the notice after an interrupted turn, and no open reply", () => {
    const rows = [
      buildTurnStarted("t1"),
      buildItemStarted("t1", "a1"),
      buildText("t1", "a1", "Half an ans"),
      buildTurnCompleted("t1", "interrupted"),
    ];
    const messages = [
      buildMessage("owner"),
      buildReply("t1", null, "Half an ans"),
      buildMessage("notice", { turnId: null, text: "Ada was interrupted: its turn was stopped" }),
    ];

    expect(describeBlocks(build({ messages, runningTurnRows: rows }))).toEqual([
      "stamp Today",
      "owner",
      "reply",
      "notice",
    ]);
  });
});

describe("describeOpenReply", () => {
  const OPEN: OpenReplyBlock = {
    kind: "open-reply",
    key: "open-reply",
    turnId: "t1",
    items: [{ itemId: "i1", rowText: "Hello" }],
    openItemId: "i1",
    pose: "working",
  };

  it("says the assistant is answering while it writes", () => {
    expect(describeOpenReply(OPEN)).toBe("answering…");
  });

  it("says the assistant is thinking while only the caret shows", () => {
    expect(describeOpenReply({ ...OPEN, items: [], openItemId: null })).toBe("thinking…");
  });

  it("names the pose while the assistant does not work", () => {
    expect(describeOpenReply({ ...OPEN, pose: "waiting" })).toBe("waiting on you");
  });
});
