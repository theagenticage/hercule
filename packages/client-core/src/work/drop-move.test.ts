/**
 * Tests the move a drop asks for: which stage and Project it names, and which
 * card the dropped card follows in stored order.
 */
import { describe, expect, it } from "vitest";
import type { BoardStage } from "@hercule/contract";
import { arrangeLanes } from "./arrange-lanes";
import { applyCardMove } from "./card-move";
import { buildBoard, buildCard, buildPlace, FAILURE, listIds } from "./cards.testing";
import { groupBoardByContext } from "./context-lanes";
import { buildDropMove } from "./drop-move";
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
  { cards = CARDS, foldedLaneId }: { cards?: typeof CARDS; foldedLaneId?: string } = {},
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

  describe("in a lane for an outside place", () => {
    const board = {
      ...buildBoard(
        buildCard("a", { projectId: "storefront", contextRefs: ["acme:project:returns"] }),
        buildCard("b", {
          projectId: "storefront",
          stage: "building",
          contextRefs: ["acme:project:returns"],
        }),
        buildCard("c", { projectId: "checkout", stage: "building" }),
        buildCard("d", { projectId: "storefront", stage: "building" }),
      ),
      places: [buildPlace("acme:project:returns", "Returns at the depots")],
      groupings: [{ kind: "acme/project", caption: "Acme project" }],
    };
    const dropOnOutside = (laneId: string, beforeCardId: string | null, folded = false) => {
      const lane = arrangeLanes(groupBoardByContext(board, "acme/project"), {
        foldedLaneIds: new Set(folded ? [laneId] : []),
        openedCellIds: new Set(),
        isFiltering: false,
      }).find((each) => each.lane.id === laneId)!;
      return buildDropMove({ movingCard: board.cards[0]!, lane, stage: "building", beforeCardId });
    };

    it.each([
      ["a place", "place:acme:project:returns", "b"],
      ["a place, with no slot", "place:acme:project:returns", null],
      ["the lane for Tasks under none", "none:acme/project", null],
    ])("changes the stage only in %s", (_, laneId, beforeCardId) => {
      const drop = dropOnOutside(laneId, beforeCardId);
      expect(drop).toEqual({ move: { taskId: "a", stage: "building" }, targetProjectId: null });
    });

    it("changes the stage only on a folded lane too", () => {
      const drop = dropOnOutside("place:acme:project:returns", null, true);
      expect(drop.move).toEqual({ taskId: "a", stage: "building" });
    });

    it("leaves the card in its Project, last in its stored cell", () => {
      const { move } = dropOnOutside("place:acme:project:returns", "b");
      const moved = applyCardMove(board, move);
      expect(moved.cards.find((card) => card.id === "a")?.projectId).toBe("storefront");
      expect(listIds(moved.cards)).toEqual(["b", "c", "d", "a"]);
    });
  });
});
