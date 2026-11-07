/**
 * Tests the move a drop asks for: which stage and Project it names, and which
 * card the dropped card follows in stored order.
 */
import { describe, expect, it } from "vitest";
import { arrangeCell } from "./arrange-cell";
import { applyCardMove } from "./card-move";
import { buildBoard, buildCard, FAILURE, listIds } from "./cards.testing";
import { buildDropMove, type DropRequest } from "./drop-move";
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

/** Builds the request for dropping `movingCardId` at `place`, on the lanes `CARDS` make. */
const requestFor = (
  movingCardId: string,
  place: DropRequest["place"],
  nextShownCardId: string | null,
  cards = CARDS,
): DropRequest => ({
  cards,
  projects: PROJECTS,
  arrangedLanes: buildLanes({ cards }, PROJECTS).map((lane) => ({
    lane,
    cells: lane.cells.map(({ stage, cards: cellCards }) => ({
      stage,
      arrangement: arrangeCell(cellCards, { stage, opened: false, filtered: false }),
    })),
  })),
  movingCardId,
  place,
  nextShownCardId,
});

describe("buildDropMove", () => {
  it("follows the card before the one the slot is in front of, and names no Project in the card's own lane", () => {
    const move = buildDropMove(
      requestFor("a", { kind: "cell", laneId: "storefront", stage: "building", index: 1 }, null),
    );
    expect(move).toEqual({ taskId: "a", stage: "building", afterTaskId: "d" });
  });

  it("puts the card first in a cell when the slot is in front of the first card", () => {
    const move = buildDropMove(
      requestFor("a", { kind: "cell", laneId: "storefront", stage: "building", index: 0 }, "d"),
    );
    expect(move).toEqual({ taskId: "a", stage: "building", afterTaskId: null });
  });

  it("leaves the moving card out when it reorders inside its own cell", () => {
    const move = buildDropMove(
      requestFor("a", { kind: "cell", laneId: "storefront", stage: "exploring", index: 1 }, "c"),
    );
    // Dropped in front of c: it now follows b.
    expect(move).toEqual({ taskId: "a", stage: "exploring", afterTaskId: "b" });
  });

  it("sends a move that leaves the order as it was for a drop on the card's own place", () => {
    const move = buildDropMove(
      requestFor("b", { kind: "cell", laneId: "storefront", stage: "exploring", index: 1 }, "c"),
    );
    expect(move).toBeDefined();
    const after = applyCardMove(buildBoard(...CARDS), move!);
    expect(listIds(after.cards)).toEqual(listIds(CARDS));
  });

  it("names the lane's Project when the card goes to another lane", () => {
    const move = buildDropMove(
      requestFor("a", { kind: "cell", laneId: "checkout", stage: "exploring", index: 1 }, null),
    );
    expect(move).toEqual({
      taskId: "a",
      stage: "exploring",
      projectId: "checkout",
      afterTaskId: "e",
    });
  });

  it("names no Project (null) when the card goes to the No project lane", () => {
    const move = buildDropMove(
      requestFor("a", { kind: "cell", laneId: "no-project", stage: "exploring", index: 0 }, "f"),
    );
    expect(move).toEqual({ taskId: "a", stage: "exploring", projectId: null, afterTaskId: null });
  });

  it("sends a card that came from No project to a Project's lane with that Project", () => {
    const move = buildDropMove(
      requestFor("f", { kind: "cell", laneId: "checkout", stage: "planned", index: 0 }, null),
    );
    expect(move).toEqual({
      taskId: "f",
      stage: "planned",
      projectId: "checkout",
      afterTaskId: null,
    });
  });

  it("leaves afterTaskId out for a folded lane, and keeps the card's stage when the drop names none", () => {
    expect(
      buildDropMove(
        requestFor("a", { kind: "folded-lane", laneId: "checkout", stage: null }, null),
      ),
    ).toEqual({ taskId: "a", stage: "exploring", projectId: "checkout" });
    expect(
      buildDropMove(
        requestFor("a", { kind: "folded-lane", laneId: "checkout", stage: "in-review" }, null),
      ),
    ).toEqual({ taskId: "a", stage: "in-review", projectId: "checkout" });
  });

  it("goes before the first hidden card when the slot is after the last card a cell shows", () => {
    const crowded = [
      ...["m1", "m2", "m3", "m4", "m5", "m6"].map((id) =>
        buildCard(id, { projectId: "storefront", stage: "planned" }),
      ),
      buildCard("x", { projectId: "storefront", stage: "exploring" }),
    ];
    // The cell shows m1 to m4, and m5 and m6 wait behind "2 more".
    const move = buildDropMove(
      requestFor(
        "x",
        { kind: "cell", laneId: "storefront", stage: "planned", index: 4 },
        null,
        crowded,
      ),
    );
    expect(move).toEqual({ taskId: "x", stage: "planned", afterTaskId: "m4" });
  });

  it("reads the stored order, not the order on screen, when a failed card leads the cell", () => {
    const withFailure = [
      buildCard("p", { projectId: "storefront", stage: "planned" }),
      buildCard("q", { projectId: "storefront", stage: "planned" }),
      buildCard("r", { projectId: "storefront", stage: "planned", failure: FAILURE }),
      buildCard("x", { projectId: "storefront", stage: "exploring" }),
    ];
    // On screen the cell reads r, p, q. Dropped in front of q, x follows p.
    const move = buildDropMove(
      requestFor(
        "x",
        { kind: "cell", laneId: "storefront", stage: "planned", index: 2 },
        "q",
        withFailure,
      ),
    );
    expect(move).toEqual({ taskId: "x", stage: "planned", afterTaskId: "p" });
  });

  it("returns nothing when the card or the lane is not on the board any more", () => {
    expect(
      buildDropMove(
        requestFor(
          "gone",
          { kind: "cell", laneId: "storefront", stage: "building", index: 0 },
          null,
        ),
      ),
    ).toBeUndefined();
    expect(
      buildDropMove(
        requestFor("a", { kind: "cell", laneId: "vanished", stage: "building", index: 0 }, null),
      ),
    ).toBeUndefined();
  });
});
