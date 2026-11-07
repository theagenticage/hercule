import { describe, expect, it } from "vitest";
import { buildBoard, buildCard } from "@hercule/client-core/work/testing";
import { buildLanes } from "@hercule/client-core/work";
import { arrangeLanes, listShownCards } from "./arrange-lanes";
import { buildCellId } from "./use-work-view";

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
});

describe("listShownCards", () => {
  it("lists the cards on screen by column, and none for a folded lane", () => {
    const open = listShownCards(arrangeLanes(lanes, CLOSED));
    const folded = listShownCards(
      arrangeLanes(lanes, { ...CLOSED, foldedLaneIds: new Set(["storefront"]) }),
    );

    expect(open[0]!.columns[0]).toEqual(["t9"]);
    expect(open[0]!.columns[2]).toEqual(["t0", "t1", "t2", "t3"]);
    expect(open[0]).toMatchObject({ id: "storefront", isFolded: false });
    expect(folded[0]).toMatchObject({ id: "storefront", isFolded: true });
    expect(folded[0]!.columns.every((column) => column.length === 0)).toBe(true);
  });
});
