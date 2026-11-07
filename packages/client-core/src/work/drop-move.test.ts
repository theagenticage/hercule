/**
 * Tests the move a drop asks for: which stage and Project it names, and which
 * card the dropped card follows in stored order.
 */
import { describe, expect, it } from "vitest";
import type { BoardStage } from "@hercule/contract";
import { arrangeLanes } from "./arrange-lanes";
import { applyCardMove } from "./card-move";
import { buildBoard, buildCard, FAILURE, listIds } from "./cards.testing";
import { buildDropMove, buildFollowerMoves, settleGroupDrop } from "./drop-move";
import { buildLanes } from "./lanes";

const PROJECTS = [
  { id: "storefront", name: "Storefront" },
  { id: "checkout", name: "Checkout" },
];

const CARDS = [
  buildCard("a", { projectId: "storefront", stage: "exploring" }),
  buildCard("b", { projectId: "storefront", stage: "exploring" }),
  buildCard("c", { projectId: "storefront", stage: "exploring" }),
  buildCard("d", { projectId: "storefront", stage: "building" }),
  buildCard("e", { projectId: "checkout", stage: "exploring" }),
  buildCard("f", { stage: "exploring" }),
];

/**
 * Drops the card `movingCardId` of `cards` on the lane `laneId` at `stage`,
 * in front of the card `beforeCardId` (`null` for last), on the lanes as the
 * board draws them. `foldedLaneId` names a lane the user folded.
 */
const buildDrop = (
  movingCardId: string,
  laneId: string,
  stage: BoardStage | null,
  beforeCardId: string | null,
  {
    cards = CARDS,
    foldedLaneId,
    followerIds,
  }: { cards?: typeof CARDS; foldedLaneId?: string; followerIds?: readonly string[] } = {},
) => {
  const lane = arrangeLanes(buildLanes({ cards }, PROJECTS), {
    foldedLaneIds: new Set(foldedLaneId === undefined ? [] : [foldedLaneId]),
    openedCellIds: new Set(),
    isFiltering: false,
  }).find((each) => each.lane.id === laneId)!;
  return buildDropMove({
    movingCard: cards.find((card) => card.id === movingCardId)!,
    lane,
    stage,
    beforeCardId,
    ...(followerIds === undefined ? {} : { followerIds }),
  });
};

/** Returns the move that dropping `movingCardId` on a lane asks for, with the arguments of `buildDrop`. */
const dropOn = (...args: Parameters<typeof buildDrop>) => buildDrop(...args).move;

describe("buildDropMove", () => {
  it("follows the card before the one the slot is in front of, and names no Project in the card's own lane", () => {
    expect(dropOn("a", "storefront", "building", null)).toEqual({
      taskId: "a",
      stage: "building",
      afterTaskId: "d",
    });
  });

  it("puts the card first in a cell when the slot is in front of the first card", () => {
    expect(dropOn("a", "storefront", "building", "d")).toEqual({
      taskId: "a",
      stage: "building",
      afterTaskId: null,
    });
  });

  it("leaves the moving card out when it reorders inside its own cell", () => {
    // Dropped in front of c: it now follows b.
    expect(dropOn("a", "storefront", "exploring", "c")).toEqual({
      taskId: "a",
      stage: "exploring",
      afterTaskId: "b",
    });
  });

  it("sends a move that leaves the order as it was for a drop on the card's own place", () => {
    const move = dropOn("b", "storefront", "exploring", "c");

    const after = applyCardMove(buildBoard(...CARDS), move);
    expect(listIds(after.cards)).toEqual(listIds(CARDS));
  });

  it("names the Project of the lane the card is let go on, also when the move leaves the Project out", () => {
    // In its own lane the move writes no Project, but a drop there still has a target to check.
    expect(buildDrop("a", "storefront", "building", null)).toMatchObject({
      move: { taskId: "a" },
      targetProjectId: "storefront",
    });
    expect(buildDrop("a", "checkout", "exploring", null).targetProjectId).toBe("checkout");
    expect(buildDrop("a", "no-project", "exploring", null).targetProjectId).toBeNull();
  });

  it("names the lane's Project when the card goes to another lane", () => {
    expect(dropOn("a", "checkout", "exploring", null)).toEqual({
      taskId: "a",
      stage: "exploring",
      projectId: "checkout",
      afterTaskId: "e",
    });
  });

  it("names no Project (null) when the card goes to the No project lane", () => {
    expect(dropOn("a", "no-project", "exploring", "f")).toEqual({
      taskId: "a",
      stage: "exploring",
      projectId: null,
      afterTaskId: null,
    });
  });

  it("sends a card that came from No project to a Project's lane with that Project", () => {
    expect(dropOn("f", "checkout", "planned", null)).toEqual({
      taskId: "f",
      stage: "planned",
      projectId: "checkout",
      afterTaskId: null,
    });
  });

  it("does not touch the Project of a card whose Project is gone when it is dropped in the lane it stands in", () => {
    const orphan = buildCard("orphan", { projectId: "deleted-project", stage: "exploring" });

    expect(dropOn("orphan", "no-project", "planned", null, { cards: [...CARDS, orphan] })).toEqual({
      taskId: "orphan",
      stage: "planned",
      afterTaskId: null,
    });
  });

  it("leaves afterTaskId out for a folded lane, and keeps the card's stage when the drop names none", () => {
    expect(dropOn("a", "checkout", null, null, { foldedLaneId: "checkout" })).toEqual({
      taskId: "a",
      stage: "exploring",
      projectId: "checkout",
    });
    expect(dropOn("a", "checkout", "in-review", null, { foldedLaneId: "checkout" })).toEqual({
      taskId: "a",
      stage: "in-review",
      projectId: "checkout",
    });
  });

  it("goes before the first hidden card when the slot is after the last card a cell shows", () => {
    const crowded = [
      ...["m1", "m2", "m3", "m4", "m5", "m6"].map((id) =>
        buildCard(id, { projectId: "storefront", stage: "planned" }),
      ),
      buildCard("x", { projectId: "storefront", stage: "exploring" }),
    ];

    // The cell shows m1 to m4, and m5 and m6 wait behind "2 more".
    expect(dropOn("x", "storefront", "planned", null, { cards: crowded })).toEqual({
      taskId: "x",
      stage: "planned",
      afterTaskId: "m4",
    });
  });

  it("reads the stored order, not the order on screen, when a failed card leads the cell", () => {
    const withFailure = [
      buildCard("p", { projectId: "storefront", stage: "planned" }),
      buildCard("q", { projectId: "storefront", stage: "planned" }),
      buildCard("r", { projectId: "storefront", stage: "planned", failure: FAILURE }),
      buildCard("x", { projectId: "storefront", stage: "exploring" }),
    ];

    // On screen the cell reads r, p, q. Dropped in front of q, x follows p.
    expect(dropOn("x", "storefront", "planned", "q", { cards: withFailure })).toEqual({
      taskId: "x",
      stage: "planned",
      afterTaskId: "p",
    });
  });
});

describe("dropping several cards", () => {
  /** Drops `leadId` with the cards `followerIds` and returns the order of the cell it lands in. */
  const dropGroup = (
    leadId: string,
    followerIds: readonly string[],
    laneId: string,
    stage: BoardStage,
    beforeCardId: string | null,
    options: { foldedLaneId?: string } = {},
  ) => {
    const drop = buildDrop(leadId, laneId, stage, beforeCardId, { ...options, followerIds });
    const followers = followerIds.map((id) => CARDS.find((card) => card.id === id)!);
    const settled = settleGroupDrop({ cards: CARDS }, PROJECTS, drop, followers);
    if (settled.kind === "refuse") throw new Error(settled.reason);
    const after = settled.moves.reduce(applyCardMove, buildBoard(...CARDS));
    return {
      settled,
      cell: listIds(
        after.cards.filter(
          (card) => card.stage === stage && (card.projectId ?? null) === drop.targetProjectId,
        ),
      ),
    };
  };

  it("leaves the cards that travel out when it looks for the card to follow", () => {
    // Cell Exploring of Storefront is a, b, c. Dropping d in front of c, with b along: it follows a.
    expect(dropOn("d", "storefront", "exploring", "c", { followerIds: ["b"] })).toEqual({
      taskId: "d",
      stage: "exploring",
      afterTaskId: "a",
    });
  });

  it("lands the cards in order right after the lead card, whatever the cell held", () => {
    const { settled, cell } = dropGroup("a", ["c", "e"], "storefront", "building", null);

    expect(settled.moves.map((move) => move.afterTaskId)).toEqual(["d", "a", "c"]);
    expect(cell).toEqual(["d", "a", "c", "e"]);
  });

  it("names the Project only for the cards that stand in another one", () => {
    const { settled } = dropGroup("e", ["a", "f"], "checkout", "planned", null);

    expect(settled.moves).toEqual([
      { taskId: "e", stage: "planned", afterTaskId: null },
      { taskId: "a", stage: "planned", projectId: "checkout", afterTaskId: "e" },
      { taskId: "f", stage: "planned", projectId: "checkout", afterTaskId: "a" },
    ]);
  });

  it("sends the cards to the No project lane with a null Project", () => {
    const { settled } = dropGroup("f", ["a"], "no-project", "planned", null);

    expect(settled.moves[1]).toEqual({
      taskId: "a",
      stage: "planned",
      projectId: null,
      afterTaskId: "f",
    });
  });

  it("names no card to follow on a folded lane, so the cards go last in turn", () => {
    const { settled } = dropGroup("a", ["b", "c"], "checkout", "planned", null, {
      foldedLaneId: "checkout",
    });

    expect(settled.moves.map((move) => move.afterTaskId)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(settled.moves.map((move) => move.taskId)).toEqual(["a", "b", "c"]);
  });

  it("leaves a follower that left the board out, and says how many", () => {
    const drop = buildDrop("a", "storefront", "building", null, { followerIds: ["b", "c"] });
    const followers = [CARDS[1]!, CARDS[2]!];
    const board = { cards: CARDS.filter((card) => card.id !== "c") };

    const settled = settleGroupDrop(board, PROJECTS, drop, followers);

    expect(settled).toEqual({
      kind: "send",
      moves: [
        { taskId: "a", stage: "building", afterTaskId: "d" },
        { taskId: "b", stage: "building", afterTaskId: "a" },
      ],
      note: "1 of the selected Tasks had left the board, so it was not moved.",
    });
  });

  it("refuses the whole drop when the lead card has left the board", () => {
    const drop = buildDrop("a", "storefront", "building", null);
    const board = { cards: CARDS.filter((card) => card.id !== "a") };

    expect(settleGroupDrop(board, PROJECTS, drop, [CARDS[1]!])).toEqual({
      kind: "refuse",
      reason: "The Task has left the board, so it was not moved.",
    });
  });

  it("keeps the note of the lead card when the card it follows has gone", () => {
    const drop = buildDrop("a", "storefront", "building", null);
    const board = { cards: CARDS.filter((card) => card.id !== "d") };

    const settled = settleGroupDrop(board, PROJECTS, drop, [CARDS[1]!]);

    expect(settled).toMatchObject({
      kind: "send",
      moves: [
        { taskId: "a", afterTaskId: null },
        { taskId: "b", afterTaskId: "a" },
      ],
      note: "The card it followed has gone, so it went last in that stage.",
    });
  });
});

describe("buildFollowerMoves", () => {
  it("builds nothing for no followers", () => {
    expect(
      buildFollowerMoves({ move: { taskId: "a", stage: "planned" }, targetProjectId: null }, []),
    ).toEqual([]);
  });
});
