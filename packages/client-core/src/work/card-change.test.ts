/**
 * Tests a card that ends and a card that returns, before the controller
 * answers: the board without the card, the board with it back in its exact
 * place, pending changes applied again in order, and the words of the undo
 * line.
 */
import { describe, expect, it } from "vitest";
import type { WorkBoard } from "@hercule/contract";
import {
  applyCardChange,
  applyCardEnd,
  applyCardReturn,
  describeCardEnd,
  describeCardEndFailure,
  reapplyCardChanges,
} from "./card-change";
import { buildMoveToPlacement, readPlacement } from "./card-move";
import { buildBoard, buildCard, listIds } from "./cards.testing";

/** Depot returns: Exploring a, b, c. Pricing rules: Exploring e. */
const BOARD: WorkBoard = buildBoard(
  buildCard("a", { projectId: "depots", boardRank: "1" }),
  buildCard("b", { projectId: "depots", boardRank: "2" }),
  buildCard("c", { projectId: "depots", boardRank: "3" }),
  buildCard("e", { projectId: "pricing", boardRank: "1" }),
);

/** Returns the ids of the cards of the Depot returns cell, in order. */
const readDepotCell = (board: WorkBoard): readonly string[] =>
  listIds(board.cards.filter((card) => card.projectId === "depots"));

describe("applyCardEnd", () => {
  it("leaves the card off the board and keeps the others in order", () => {
    expect(listIds(applyCardEnd(BOARD, "b").cards)).toEqual(["a", "c", "e"]);
  });

  it("returns the board itself when the card is not on it", () => {
    expect(applyCardEnd(BOARD, "gone")).toBe(BOARD);
  });
});

describe("applyCardReturn", () => {
  it.each([
    ["in the middle of its cell", "b"],
    ["first in its cell", "a"],
    ["last in its cell", "c"],
  ])("puts a card that ended %s back where it stood", (_, id) => {
    const card = BOARD.cards.find((each) => each.id === id)!;
    const placement = readPlacement(BOARD, id)!;
    const ended = applyCardEnd(BOARD, id);
    const { move } = buildMoveToPlacement(ended, placement);
    expect(readDepotCell(applyCardReturn(ended, card, move))).toEqual(["a", "b", "c"]);
  });

  it("puts the card last in its cell when the card it followed is gone, and says it is not exact", () => {
    const card = BOARD.cards.find((each) => each.id === "c")!;
    const placement = readPlacement(BOARD, "c")!;
    const ended = applyCardEnd(applyCardEnd(BOARD, "c"), "b");
    const restore = buildMoveToPlacement(ended, placement);
    expect(restore.exact).toBe(false);
    expect(restore.move.afterTaskId).toBe("a");
    expect(readDepotCell(applyCardReturn(ended, card, restore.move))).toEqual(["a", "c"]);
  });

  it("returns the board itself when a read already brought the card back", () => {
    const card = BOARD.cards[0]!;
    expect(applyCardReturn(BOARD, card, { taskId: "a", afterTaskId: null })).toBe(BOARD);
  });
});

describe("reapplyCardChanges", () => {
  it("applies a move, an end and a return in the order they were made", () => {
    const b = BOARD.cards.find((each) => each.id === "b")!;
    const result = reapplyCardChanges(BOARD, [
      { kind: "end", card: b, stage: "done" },
      { kind: "move", move: { taskId: "a", afterTaskId: "c" } },
      { kind: "return", card: b, move: { taskId: "b", stage: "exploring", afterTaskId: "c" } },
    ]);
    expect(listIds(result.cards)).toEqual(["c", "b", "a", "e"]);
  });

  it("returns the board itself for no changes", () => {
    expect(reapplyCardChanges(BOARD, [])).toBe(BOARD);
  });

  it("applies one change like applyCardChange does", () => {
    const change = { kind: "end", card: BOARD.cards[0]!, stage: "dropped" } as const;
    expect(reapplyCardChanges(BOARD, [change])).toEqual(applyCardChange(BOARD, change));
  });
});

describe("the words of an end", () => {
  const card = buildCard("a", { title: "Review PR" });

  it.each([
    ["done", 'Marked "Review PR" Done'],
    ["dropped", 'Dropped "Review PR"'],
  ] as const)("says what ending at %s did", (stage, words) => {
    expect(describeCardEnd(card, stage)).toBe(words);
  });

  it("cuts a long title", () => {
    const long = buildCard("a", { title: "Refund emails show the wrong currency for gift cards" });
    expect(describeCardEnd(long, "dropped")).toBe('Dropped "Refund emails show the wrong cu…"');
  });

  it.each([
    [
      "done",
      "Order is locked.",
      'Marking "Review PR" Done did not save, so the card came back: Order is locked. Try again.',
    ],
    [
      "dropped",
      "Could not reach the controller",
      'Dropping "Review PR" did not save, so the card came back: Could not reach the controller. Try again.',
    ],
  ] as const)("says why ending at %s failed, once", (stage, reason, words) => {
    expect(describeCardEndFailure(card, stage, reason)).toBe(words);
  });
});
