/**
 * Tests which message counts as the session's first, and so folds its
 * context block, in the three places that ask: the thread's turns, its
 * blocks, and the messages still sending.
 */
import { describe, expect, it } from "vitest";
import { appendPromptContext, type Input, type TranscriptRow } from "@hercule/contract";
import type { AgentState } from "./agent-state";
import { buildThreadBlocks } from "./blocks";
import { findFirstMessageItemId, splitSendingTexts } from "./first-message";
import { buildTurns } from "./turns";

const BLOCK = appendPromptContext("", {
  origin: { kind: "one" },
  things: [
    {
      entityId: "01a1317e-d8d3-7402-8971-cfcc37f653cb",
      ref: "linear:issue:northwind/SHOP-142",
      fields: [],
    },
  ],
});
const SENT = `Look into this.\n\n${BLOCK}`;
const FOLDED = { text: "Look into this.", context: { text: BLOCK } };

const SESSION = {
  working: false,
  mayBeRunningTurn: false,
  openRequests: [],
  model: "claude-sonnet-5",
  isSubagent: false,
} satisfies AgentState;
const SUBAGENT = { ...SESSION, isSubagent: true } satisfies AgentState;

/** Returns the `item.started` row of a user message with the given text. */
const buildMessageRow = (itemId: string, turnId: string, text: string): TranscriptRow => {
  const event = {
    _tag: "item.started",
    eventId: `e-${itemId}`,
    sessionId: "s1",
    at: "2026-09-08T10:00:00.000Z",
    turnId,
    itemId,
    kind: "user_message",
    detail: { text },
  } satisfies TranscriptRow["event"];
  return { position: 0, at: event.at, event };
};

/** Returns an input still sending, with the given text. */
const buildSendingInput = (id: string, text: string): Input => ({
  id,
  sessionId: "s1",
  source: "user",
  actor: "user",
  text,
  attachments: [],
  status: "queued",
  delivery: null,
  createdAt: "2026-09-08T10:00:00.000Z",
  deliveredAt: null,
  sentAt: "2026-09-08T10:00:00.000Z",
  reason: null,
});

const TWO_MESSAGES = [buildMessageRow("u1", "t1", SENT), buildMessageRow("u2", "t2", SENT)];

describe("the session's first message, read from the transcript", () => {
  const cases: readonly {
    readonly name: string;
    readonly agent: AgentState;
    readonly folded: readonly string[];
  }[] = [
    { name: "folds in the first message, whoever sent it", agent: SESSION, folded: ["u1"] },
    { name: "keeps a subagent's brief as text", agent: SUBAGENT, folded: [] },
  ];

  for (const { name, agent, folded } of cases) {
    it(`${name}, and keeps a later message as text`, () => {
      const fromTurns = buildTurns(TWO_MESSAGES, agent).turns.flatMap((turn) => turn.userMessages);
      const fromBlocks = buildThreadBlocks(TWO_MESSAGES, agent).filter(
        (block) => block.kind === "user",
      );
      for (const message of [...fromTurns, ...fromBlocks]) {
        if (folded.includes(message.itemId)) {
          expect(message).toMatchObject(FOLDED);
        } else {
          expect(message).toMatchObject({ text: SENT });
          expect(message).not.toHaveProperty("context");
        }
      }
      expect(findFirstMessageItemId(TWO_MESSAGES, agent)).toBe(folded[0]);
    });
  }

  it("finds no first message in an empty transcript", () => {
    expect(findFirstMessageItemId([], SESSION)).toBeUndefined();
  });
});

describe("splitSendingTexts", () => {
  const first = buildSendingInput("in-1", SENT);
  const second = buildSendingInput("in-2", SENT);

  it("folds the first sending input while the transcript holds no message", () => {
    const [folded, plain] = splitSendingTexts([], [first, second]);
    expect(folded).toMatchObject(FOLDED);
    expect(plain).toEqual({ text: SENT });
  });

  it("folds the first input in the moment after its message reached the transcript", () => {
    expect(splitSendingTexts([buildMessageRow("u1", "t1", SENT)], [first])[0]).toMatchObject(
      FOLDED,
    );
  });

  it("keeps a later input as text when the transcript's first message differs from it", () => {
    const later = buildSendingInput("in-3", `Another.\n\n${BLOCK}`);
    expect(splitSendingTexts([buildMessageRow("u1", "t1", SENT)], [later])).toEqual([
      { text: later.text },
    ]);
  });

  it("keeps every sending input as text once the transcript holds a different message", () => {
    expect(splitSendingTexts([buildMessageRow("u1", "t1", "Hi")], [first, second])).toEqual([
      { text: SENT },
      { text: SENT },
    ]);
  });
});
