/**
 * Tests moving a card before the controller answers: the projection over the
 * board, pending moves applied again, where a card stood, which card a drop
 * follows in stored order, and which stage a key moves a card to, and what a drop becomes on a board
 * that changed under it.
 */
import { describe, expect, it } from "vitest";
import type { WorkBoard } from "@hercule/contract";
import {
  applyCardMove,
  buildRestoreMove,
  chooseAfterTaskId,
  CARD_NOT_EXACT_NOTE,
  chooseTargetStage,
  readPlacement,
  reapplyCardMoves,
  settleDropMove,
} from "./card-move";
import { buildBoard, buildCard, FAILURE, listIds } from "./cards.testing";
import { buildLanes } from "./lanes";

const PROJECTS = [
  { id: "depots", name: "Depot returns" },
  { id: "pricing", name: "Pricing rules" },
];

/** Depot returns: Exploring a, b, c; Building d. Pricing rules, Exploring e. One loose card f. */
const BOARD: WorkBoard = buildBoard(
  buildCard("a", { projectId: "depots", boardRank: "1" }),
  buildCard("b", { projectId: "depots", boardRank: "2" }),
  buildCard("c", { projectId: "depots", boardRank: "3" }),
  buildCard("d", { projectId: "depots", stage: "building", boardRank: "1" }),
  buildCard("e", { projectId: "pricing", boardRank: "1" }),
  buildCard("f", { boardRank: "1" }),
);

/** Returns the ids of the cards of one cell of the lanes, as the screen would draw the board. */
const readCell = (board: WorkBoard, laneId: string, stage: string): readonly string[] => {
  const lane = buildLanes(board, PROJECTS).find((other) => other.id === laneId);
  return listIds(lane?.cells.find((cell) => cell.stage === stage)?.cards ?? []);
};

describe("applyCardMove", () => {
  it.each([
    ["after a card of its own cell", { afterTaskId: "b" }, ["a", "b", "x", "c"]],
    ["first, for null", { afterTaskId: null }, ["x", "a", "b", "c"]],
    ["after the last card", { afterTaskId: "c" }, ["a", "b", "c", "x"]],
  ])("puts a card of the same cell %s", (_, move, expected) => {
    const board = buildBoard(
      buildCard("a", { projectId: "depots" }),
      buildCard("x", { projectId: "depots" }),
      buildCard("b", { projectId: "depots" }),
      buildCard("c", { projectId: "depots" }),
    );
    expect(readCell(applyCardMove(board, { taskId: "x", ...move }), "depots", "exploring")).toEqual(
      expected,
    );
  });

  it("moves a card to another stage after a card, first, and last", () => {
    const after = applyCardMove(BOARD, { taskId: "a", stage: "building", afterTaskId: "d" });
    expect(readCell(after, "depots", "building")).toEqual(["d", "a"]);
    expect(readCell(after, "depots", "exploring")).toEqual(["b", "c"]);
    const first = applyCardMove(BOARD, { taskId: "a", stage: "building", afterTaskId: null });
    expect(readCell(first, "depots", "building")).toEqual(["a", "d"]);
    const last = applyCardMove(BOARD, { taskId: "a", stage: "building" });
    expect(readCell(last, "depots", "building")).toEqual(["d", "a"]);
  });

  it("changes the stage and keeps the rest of the card", () => {
    const moved = applyCardMove(BOARD, { taskId: "a", stage: "planned" }).cards.find(
      (card) => card.id === "a",
    );
    expect(moved).toEqual({ ...BOARD.cards[0], stage: "planned" });
  });

  it("moves a card to another Project, and to no Project with null", () => {
    const toPricing = applyCardMove(BOARD, { taskId: "a", projectId: "pricing" });
    expect(readCell(toPricing, "pricing", "exploring")).toEqual(["e", "a"]);
    const toNone = applyCardMove(BOARD, { taskId: "a", projectId: null });
    expect(readCell(toNone, "no-project", "exploring")).toEqual(["f", "a"]);
    expect(toNone.cards.find((card) => card.id === "a")).not.toHaveProperty("projectId");
  });

  it("fills an empty cell", () => {
    const moved = applyCardMove(BOARD, { taskId: "a", stage: "landed", afterTaskId: null });
    expect(readCell(moved, "depots", "landed")).toEqual(["a"]);
  });

  it("keeps the boardRank of the moved card and gives it no new one", () => {
    const moved = applyCardMove(BOARD, { taskId: "a", afterTaskId: "c" });
    expect(moved.cards.find((card) => card.id === "a")?.boardRank).toBe("1");
  });

  it("keeps the order a second pending move expects", () => {
    // a goes after c, then b goes first: b, c, a.
    const board = reapplyCardMoves(BOARD, [
      { taskId: "a", afterTaskId: "c" },
      { taskId: "b", afterTaskId: null },
    ]);
    expect(readCell(board, "depots", "exploring")).toEqual(["b", "c", "a"]);
  });

  it("does not change the board it is given", () => {
    const before = listIds(BOARD.cards);
    applyCardMove(BOARD, { taskId: "a", afterTaskId: "c" });
    expect(listIds(BOARD.cards)).toEqual(before);
  });

  it.each([
    ["the card is gone", { taskId: "gone", stage: "planned" as const }],
    ["the card it follows is gone", { taskId: "a", afterTaskId: "gone" }],
    ["the card it follows is in another cell", { taskId: "a", afterTaskId: "d" }],
    ["it follows itself", { taskId: "a", afterTaskId: "a" }],
    ["it stays in its cell and names no place", { taskId: "a" }],
    ["it names its own cell and no place", { taskId: "a", stage: "exploring" as const }],
  ])("does nothing when %s", (_, move) => {
    expect(applyCardMove(BOARD, move)).toBe(BOARD);
  });
});

describe("reapplyCardMoves", () => {
  it("applies the moves in order, and skips one whose card a fresh board no longer has", () => {
    const fresh = buildBoard(...BOARD.cards.filter((card) => card.id !== "b"));
    const board = reapplyCardMoves(fresh, [
      { taskId: "b", stage: "planned" },
      { taskId: "a", afterTaskId: "c" },
      { taskId: "c", afterTaskId: "gone" },
    ]);
    expect(readCell(board, "depots", "exploring")).toEqual(["c", "a"]);
  });

  it("returns the board itself for no moves", () => {
    expect(reapplyCardMoves(BOARD, [])).toBe(BOARD);
  });
});

describe("readPlacement and buildRestoreMove", () => {
  it("reads the cell and the card before it", () => {
    expect(readPlacement(BOARD, "b")).toEqual({
      taskId: "b",
      stage: "exploring",
      projectId: "depots",
      afterTaskId: "a",
    });
    expect(readPlacement(BOARD, "a")).toMatchObject({ afterTaskId: null });
    expect(readPlacement(BOARD, "f")).toMatchObject({ projectId: null, afterTaskId: null });
  });

  it("reads nothing for a card that is gone", () => {
    expect(readPlacement(BOARD, "gone")).toBeUndefined();
  });

  it("puts a moved card back exactly, also inside its own cell", () => {
    const placement = readPlacement(BOARD, "b")!;
    const moved = applyCardMove(BOARD, { taskId: "b", stage: "building" });
    const restore = buildRestoreMove(moved, placement)!;
    expect(restore.exact).toBe(true);
    expect(readCell(applyCardMove(moved, restore.move), "depots", "exploring")).toEqual([
      "a",
      "b",
      "c",
    ]);
    const within = applyCardMove(BOARD, { taskId: "b", afterTaskId: "c" });
    const back = buildRestoreMove(within, placement)!;
    expect(readCell(applyCardMove(within, back.move), "depots", "exploring")).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("says so, and sends the card last, when the card it followed has left the cell", () => {
    const placement = readPlacement(BOARD, "b")!;
    const moved = applyCardMove(applyCardMove(BOARD, { taskId: "b", afterTaskId: "c" }), {
      taskId: "a",
      stage: "planned",
    });
    const restore = buildRestoreMove(moved, placement)!;
    expect(restore.exact).toBe(false);
    expect(restore.move).toMatchObject({ afterTaskId: "c" });
  });

  it("puts a card that was first back first", () => {
    const placement = readPlacement(BOARD, "a")!;
    const moved = applyCardMove(BOARD, { taskId: "a", afterTaskId: "c" });
    expect(buildRestoreMove(moved, placement)).toMatchObject({
      exact: true,
      move: { afterTaskId: null },
    });
  });

  it("builds no move for a card that is gone", () => {
    const placement = readPlacement(BOARD, "a")!;
    expect(
      buildRestoreMove(buildBoard(...BOARD.cards.filter((card) => card.id !== "a")), placement),
    ).toBeUndefined();
  });
});

describe("chooseAfterTaskId", () => {
  // Stored order. f1 and f2 have failed, so the screen draws f1, f2, a, b, c.
  const STORED = [
    buildCard("a"),
    buildCard("f1", { failure: FAILURE }),
    buildCard("b"),
    buildCard("f2", { failure: FAILURE }),
    buildCard("c"),
  ];

  it.each([
    ["before a card that is not failed", "b", "f1"],
    ["before the first card that is not failed", "a", null],
    ["at the end", null, "c"],
    ["before the last card", "c", "f2"],
  ])("lands a card that is not failed %s", (_, nextVisibleCardId, expected) => {
    expect(
      chooseAfterTaskId({ storedCell: STORED, nextVisibleCardId, movingCardFailed: false }),
    ).toBe(expected);
  });

  it.each(["f1", "f2"])(
    "lands a card that is not failed, dropped on the floating failed card %s, before the first card that is not failed",
    (nextVisibleCardId) => {
      expect(
        chooseAfterTaskId({ storedCell: STORED, nextVisibleCardId, movingCardFailed: false }),
      ).toBeNull();
    },
  );

  it("lands a failed card by the place of the failed card that follows it", () => {
    expect(
      chooseAfterTaskId({ storedCell: STORED, nextVisibleCardId: "f2", movingCardFailed: true }),
    ).toBe("b");
    expect(
      chooseAfterTaskId({ storedCell: STORED, nextVisibleCardId: "f1", movingCardFailed: true }),
    ).toBe("a");
  });

  it("lands at the end of a cell of only failed cards after all of them", () => {
    const onlyFailed = [
      buildCard("f1", { failure: FAILURE }),
      buildCard("f2", { failure: FAILURE }),
    ];
    expect(
      chooseAfterTaskId({
        storedCell: onlyFailed,
        nextVisibleCardId: "f1",
        movingCardFailed: false,
      }),
    ).toBe("f2");
  });

  it("lands first in an empty cell", () => {
    expect(
      chooseAfterTaskId({ storedCell: [], nextVisibleCardId: null, movingCardFailed: false }),
    ).toBeNull();
  });

  it("treats a following card that is not in the cell as the end", () => {
    expect(
      chooseAfterTaskId({ storedCell: STORED, nextVisibleCardId: "gone", movingCardFailed: false }),
    ).toBe("c");
  });
});

describe("chooseTargetStage", () => {
  it.each([
    ["exploring", { kind: "shift-stage", direction: 1 }, "planned"],
    ["building", { kind: "shift-stage", direction: -1 }, "planned"],
    ["exploring", { kind: "shift-stage", direction: -1 }, undefined],
    ["landed", { kind: "shift-stage", direction: 1 }, undefined],
    ["building", { kind: "pick-stage", stage: "landed" }, "landed"],
    ["building", { kind: "pick-stage", stage: "building" }, undefined],
  ] as const)("moves a card at %s on %j to %s", (stage, change, expected) => {
    expect(chooseTargetStage({ stage }, change)).toBe(expected);
  });
});

describe("settleDropMove", () => {
  const withoutCard = (id: string): WorkBoard =>
    buildBoard(...BOARD.cards.filter((card) => card.id !== id));

  it("sends a drop as it is while the card it follows is still in the target cell", () => {
    const move = { taskId: "a", stage: "building" as const, afterTaskId: "d" };

    expect(settleDropMove(BOARD, PROJECTS, move)).toEqual({ kind: "send", move });
  });

  it("sends a drop that names no card to follow as it is", () => {
    for (const afterTaskId of [null, undefined]) {
      const move = {
        taskId: "a",
        stage: "building" as const,
        ...(afterTaskId === undefined ? {} : { afterTaskId }),
      };

      expect(settleDropMove(BOARD, PROJECTS, move)).toEqual({ kind: "send", move });
    }
  });

  it("puts the card last in the cell, and says so, when the card it follows has left the board", () => {
    const board = withoutCard("c");
    const settled = settleDropMove(board, PROJECTS, {
      taskId: "d",
      stage: "exploring",
      afterTaskId: "c",
    });

    expect(settled).toEqual({
      kind: "send",
      move: { taskId: "d", stage: "exploring", afterTaskId: "b" },
      note: CARD_NOT_EXACT_NOTE,
    });
    if (settled.kind !== "send") throw new Error("expected a move");
    expect(readCell(applyCardMove(board, settled.move), "depots", "exploring")).toEqual([
      "a",
      "b",
      "d",
    ]);
  });

  it("puts the card last when the card it follows has moved to another cell", () => {
    const settled = settleDropMove(BOARD, PROJECTS, {
      taskId: "a",
      stage: "building",
      afterTaskId: "b",
    });

    expect(settled).toMatchObject({ move: { afterTaskId: "d" }, note: CARD_NOT_EXACT_NOTE });
  });

  it("puts the card first, and says so, in a cell that has emptied", () => {
    const settled = settleDropMove(withoutCard("d"), PROJECTS, {
      taskId: "a",
      stage: "building",
      afterTaskId: "d",
    });

    expect(settled).toMatchObject({ move: { afterTaskId: null }, note: CARD_NOT_EXACT_NOTE });
  });

  it("looks for the card to follow in the lane the drop names", () => {
    const settled = settleDropMove(BOARD, PROJECTS, {
      taskId: "a",
      stage: "exploring",
      projectId: "pricing",
      afterTaskId: "b",
    });

    // b is in the Depot returns lane, not in Pricing rules.
    expect(settled).toMatchObject({ move: { afterTaskId: "e" }, note: CARD_NOT_EXACT_NOTE });
  });

  it("sends nothing, and says why, when the Task has left the board", () => {
    const settled = settleDropMove(withoutCard("a"), PROJECTS, {
      taskId: "a",
      stage: "building",
      afterTaskId: "d",
    });

    expect(settled).toEqual({
      kind: "refuse",
      reason: "The Task has left the board, so it was not moved.",
    });
  });

  it("sends nothing, and says why, when the Project it was dropped on is gone", () => {
    const settled = settleDropMove(BOARD, [PROJECTS[0]!], {
      taskId: "a",
      stage: "exploring",
      projectId: "pricing",
      afterTaskId: null,
    });

    expect(settled).toMatchObject({ kind: "refuse" });
  });
});
