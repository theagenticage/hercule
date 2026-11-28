/**
 * Tests the logical board: how the pending moves, the held answers and the held
 * merges combine over the server board, and that an action which reads it
 * never meets a card that a held merge took off the board.
 */
import { describe, expect, it } from "vitest";
import { buildBoard, buildCard, listIds, QUESTION } from "./cards.testing";
import type { CardChange } from "./card-change";
import { settleGroupDrop } from "./drop-move";
import { buildLogicalBoard, type PendingBoardChanges } from "./logical-board";

const NOTHING_PENDING: PendingBoardChanges = { changes: [], heldAnswers: [], heldMerges: [] };

const A = buildCard("a", { boardRank: "1" });
const B = buildCard("b", { boardRank: "2" });
const C = buildCard("c", { boardRank: "3", openQuestion: QUESTION });
const SERVER = buildBoard(A, B, C);

const MOVE_A_BUILDING: CardChange = { kind: "move", move: { taskId: "a", stage: "building" } };
const ANSWER_C = {
  sessionId: QUESTION.sessionId,
  requestId: QUESTION.requestId,
  answers: { q: "Yes" },
};

describe("buildLogicalBoard", () => {
  const cases: readonly {
    readonly name: string;
    readonly pending: PendingBoardChanges;
    readonly ids: readonly string[];
    readonly hidden: readonly string[];
    readonly check?: (cards: ReturnType<typeof buildLogicalBoard>["board"]["cards"]) => void;
  }[] = [
    { name: "nothing pending", pending: NOTHING_PENDING, ids: ["a", "b", "c"], hidden: [] },
    {
      name: "a pending move",
      pending: { ...NOTHING_PENDING, changes: [MOVE_A_BUILDING] },
      // The moved card goes last in its new stage, which is last in stored order.
      ids: ["b", "c", "a"],
      hidden: [],
      check: (cards) => {
        expect(cards.find((card) => card.id === "a")?.stage).toBe("building");
      },
    },
    {
      name: "a pending end",
      pending: {
        ...NOTHING_PENDING,
        changes: [{ kind: "end", card: B, stage: "done" }],
      },
      ids: ["a", "c"],
      hidden: [],
    },
    {
      name: "a held answer",
      pending: { ...NOTHING_PENDING, heldAnswers: [ANSWER_C] },
      ids: ["a", "b", "c"],
      hidden: [],
      check: (cards) => {
        const answered = cards.find((card) => card.id === "c");
        expect(answered?.openQuestion).toBeUndefined();
        expect(answered).toHaveProperty("heldAnswer");
      },
    },
    {
      name: "a held merge",
      pending: { ...NOTHING_PENDING, heldMerges: [{ taskId: "b" }] },
      ids: ["a", "c"],
      hidden: ["b"],
    },
    {
      name: "a card moved and then merged away",
      pending: { changes: [MOVE_A_BUILDING], heldAnswers: [], heldMerges: [{ taskId: "a" }] },
      ids: ["b", "c"],
      hidden: ["a"],
    },
    {
      name: "a held merge of a Task that is not on the board",
      pending: { ...NOTHING_PENDING, heldMerges: [{ taskId: "gone" }] },
      ids: ["a", "b", "c"],
      hidden: [],
    },
    {
      name: "an answer and a merge together",
      pending: { changes: [], heldAnswers: [ANSWER_C], heldMerges: [{ taskId: "a" }] },
      ids: ["b", "c"],
      hidden: ["a"],
      check: (cards) => {
        expect(cards.find((card) => card.id === "c")?.openQuestion).toBeUndefined();
      },
    },
  ];

  it.each(cases)("$name", ({ pending, ids, hidden, check }) => {
    const logical = buildLogicalBoard(SERVER, pending);

    expect(listIds(logical.board.cards)).toEqual(ids);
    expect([...logical.hiddenIds]).toEqual(hidden);
    check?.(logical.board.cards);
  });

  it("returns the server board itself when nothing is pending", () => {
    expect(buildLogicalBoard(SERVER, NOTHING_PENDING).board).toBe(SERVER);
  });

  it("keeps the card objects that no pending change touches", () => {
    const { board } = buildLogicalBoard(SERVER, {
      changes: [],
      heldAnswers: [ANSWER_C],
      heldMerges: [{ taskId: "a" }],
    });

    expect(board.cards.find((card) => card.id === "b")).toBe(B);
  });

  it("names the Tasks whose stage the user moved, and no other", () => {
    const reorder: CardChange = { kind: "move", move: { taskId: "b", afterTaskId: null } };
    const { movedIds } = buildLogicalBoard(SERVER, {
      ...NOTHING_PENDING,
      changes: [MOVE_A_BUILDING, reorder],
    });

    expect([...movedIds]).toEqual(["a"]);
    expect(buildLogicalBoard(SERVER, NOTHING_PENDING).movedIds.size).toBe(0);
  });

  it("keeps the truncated flag of the server board", () => {
    const truncated = { ...SERVER, truncated: true };

    expect(
      buildLogicalBoard(truncated, { ...NOTHING_PENDING, heldMerges: [{ taskId: "a" }] }).board
        .truncated,
    ).toBe(true);
  });
});

describe("a drop next to a card that a held merge took off the board", () => {
  const cell = (id: string, rank: string) => buildCard(id, { stage: "exploring", boardRank: rank });
  // x, y and the merge source z stand in one cell, z last. The drop meant to
  // follow w, which has left the board since the carry began.
  const server = buildBoard(cell("m", "0"), cell("x", "1"), cell("y", "2"), cell("z", "3"));
  const dropAfterWhatLeft = {
    move: { taskId: "m", stage: "exploring" as const, afterTaskId: "w" },
    targetProjectId: null,
  };

  it("lands last among the cards that are on the board, never after the hidden source", () => {
    const { board } = buildLogicalBoard(server, {
      ...NOTHING_PENDING,
      heldMerges: [{ taskId: "z" }],
    });

    const settled = settleGroupDrop(board, [], dropAfterWhatLeft, []);

    expect(settled).toMatchObject({ kind: "send", moves: [{ afterTaskId: "y" }] });
  });

  it("would have chosen the hidden source on the board without the held merge", () => {
    const settled = settleGroupDrop(server, [], dropAfterWhatLeft, []);

    expect(settled).toMatchObject({ kind: "send", moves: [{ afterTaskId: "z" }] });
  });
});
