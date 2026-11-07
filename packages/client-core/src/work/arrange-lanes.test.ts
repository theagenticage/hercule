/** Tests the lanes as the board draws them: what each cell shows, the failed count, the dots, and the counts over the stages. */
import { describe, expect, it } from "vitest";
import { arrangeLanes, buildCellId, countCardsByStage } from "./arrange-lanes";
import { buildBoard, buildCard, FAILURE, QUESTION } from "./cards.testing";
import { buildLanes } from "./lanes";

const PROJECTS = [{ id: "storefront", name: "Storefront" }];
const CLOSED = {
  foldedLaneIds: new Set<string>(),
  openedCellIds: new Set<string>(),
  isFiltering: false,
};

const manyCards = Array.from({ length: 8 }, (_, index) =>
  buildCard(`t${String(index)}`, { projectId: "storefront", stage: "building" }),
);
const lanes = buildLanes(
  buildBoard(...manyCards, buildCard("t9", { projectId: "storefront" })),
  PROJECTS,
);

describe("arrangeLanes", () => {
  it("shows four cards of a cell of eight and a line for the rest", () => {
    const [lane] = arrangeLanes(lanes, CLOSED);
    const building = lane!.cells.find((cell) => cell.stage === "building")!;

    expect(building.arrangement.cards).toHaveLength(4);
    expect(building.arrangement.foot).toBe("more");
    expect(building.cardCount).toBe(8);
  });

  it("shows every card of a cell the user opened", () => {
    const opened = { ...CLOSED, openedCellIds: new Set([buildCellId("storefront", "building")]) };
    const building = arrangeLanes(lanes, opened)[0]!.cells.find(
      (cell) => cell.stage === "building",
    )!;

    expect(building.arrangement.cards).toHaveLength(8);
    expect(building.arrangement.foot).toBe("fewer");
  });

  it("marks the lanes the user folded", () => {
    const folded = arrangeLanes(lanes, { ...CLOSED, foldedLaneIds: new Set(["storefront"]) });

    expect(folded[0]!.isFolded).toBe(true);
    expect(arrangeLanes(lanes, CLOSED)[0]!.isFolded).toBe(false);
  });

  it("counts the failed cards of a lane, also in Landed, and no failure for a question", () => {
    const [failing] = arrangeLanes(
      buildLanes(
        buildBoard(
          buildCard("a", { projectId: "storefront" }),
          buildCard("d", { projectId: "storefront", stage: "landed", failure: FAILURE }),
          buildCard("e", { projectId: "storefront", stage: "building", failure: FAILURE }),
        ),
        PROJECTS,
      ),
      CLOSED,
    );
    const [asking] = arrangeLanes(
      buildLanes(buildBoard(buildCard("a", { openQuestion: QUESTION })), []),
      CLOSED,
    );

    expect(failing!.failedCount).toBe(2);
    expect(asking!.failedCount).toBe(0);
  });

  it.each([
    ["no cards", [], null],
    ["cards with nothing to say", [buildCard("a")], null],
    [
      "a card with a question",
      [buildCard("a"), buildCard("b", { openQuestion: QUESTION })],
      "question",
    ],
    ["a card that failed", [buildCard("a", { failure: FAILURE })], "failed"],
    [
      "a failure and a question",
      [buildCard("a", { openQuestion: QUESTION }), buildCard("b", { failure: FAILURE })],
      "failed",
    ],
  ])("gives the Building cell of a lane with %s the dot %s", (_name, cards, expected) => {
    // A card in Exploring keeps the lane on the board when Building has none.
    const board = buildBoard(
      buildCard("z"),
      ...cards.map((card) => ({ ...card, stage: "building" as const })),
    );
    const [lane] = arrangeLanes(buildLanes(board, []), CLOSED);

    expect(lane!.cells.find((cell) => cell.stage === "building")!.dot).toBe(expected);
  });
});

describe("countCardsByStage", () => {
  it("counts the cards of each stage across the lanes, those behind a line too, and 0 for a stage with none", () => {
    const counts = countCardsByStage(
      arrangeLanes(
        buildLanes(
          buildBoard(
            ...manyCards,
            buildCard("t9", { projectId: "storefront" }),
            buildCard("loose"),
            buildCard("review", { stage: "in-review" }),
          ),
          PROJECTS,
        ),
        CLOSED,
      ),
    );

    expect(counts).toEqual({ exploring: 2, planned: 0, building: 8, "in-review": 1, landed: 0 });
  });
});
