/**
 * Tests where a carried card would land for a pointer at a given place, on
 * measurements written out by hand: three stages, two open lanes and a
 * folded one.
 */
import { describe, expect, it } from "vitest";
import type { DropPlace } from "@hercule/client-core/work";
import {
  chooseDropPlace,
  computeEdgeScrollSpeed,
  isSameDropPlace,
  toBoardPoint,
  type BoardGeometry,
  type CellBox,
  type LaneBox,
} from "./board-drag-geometry";

const element = (): HTMLElement => document.createElement("div");

/** Returns a cell whose cards have their middles at these heights. */
const cellWithMiddles = (...middles: number[]): CellBox => ({
  element: element(),
  rows: middles.map((middle, index) => ({
    id: `card-${String(index)}`,
    element: element(),
    middle,
  })),
});

const openLane = (
  id: string,
  top: number,
  bottom: number,
  cells: Partial<Record<string, CellBox>>,
): LaneBox => ({
  id,
  element: element(),
  top,
  bottom,
  isFolded: false,
  cells: new Map(
    (["exploring", "planned", "building", "in-review", "landed"] as const).map((stage) => [
      stage,
      cells[stage] ?? cellWithMiddles(),
    ]),
  ),
});

const GEOMETRY: BoardGeometry = {
  stageEdges: [
    { stage: "exploring", left: 200 },
    { stage: "planned", left: 350 },
    { stage: "building", left: 500 },
    { stage: "in-review", left: 650 },
    { stage: "landed", left: 800 },
  ],
  lanes: [
    openLane("storefront", 100, 400, { building: cellWithMiddles(150, 260, 370) }),
    { ...openLane("checkout", 400, 444, {}), isFolded: true, cells: new Map() },
    openLane("no-project", 444, 700, {}),
  ],
};

describe("chooseDropPlace", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly x: number;
    readonly y: number;
    readonly expected: DropPlace;
  }> = [
    {
      name: "puts the card first in a cell when the pointer is above the first middle",
      x: 520,
      y: 120,
      expected: { kind: "cell", laneId: "storefront", stage: "building", beforeCardId: "card-0" },
    },
    {
      name: "puts the card after each card whose middle the pointer is below",
      x: 520,
      y: 300,
      expected: { kind: "cell", laneId: "storefront", stage: "building", beforeCardId: "card-2" },
    },
    {
      name: "puts the card last when the pointer is below every middle",
      x: 520,
      y: 395,
      expected: { kind: "cell", laneId: "storefront", stage: "building", beforeCardId: null },
    },
    {
      name: "puts the card before nothing in a cell with no card",
      x: 220,
      y: 300,
      expected: { kind: "cell", laneId: "storefront", stage: "exploring", beforeCardId: null },
    },
    {
      name: "counts a pointer in the gap before a stage as inside that stage",
      x: 345,
      y: 300,
      expected: { kind: "cell", laneId: "storefront", stage: "planned", beforeCardId: null },
    },
    {
      name: "picks the first stage for a pointer left of all stages",
      x: 20,
      y: 300,
      expected: { kind: "cell", laneId: "storefront", stage: "exploring", beforeCardId: null },
    },
    {
      name: "picks the last stage for a pointer right of all stages",
      x: 1190,
      y: 500,
      expected: { kind: "cell", laneId: "no-project", stage: "landed", beforeCardId: null },
    },
    {
      name: "picks the nearest lane for a pointer above the first lane",
      x: 520,
      y: 20,
      expected: { kind: "cell", laneId: "storefront", stage: "building", beforeCardId: "card-0" },
    },
    {
      name: "targets a folded lane as a whole, with the stage the pointer is over",
      x: 520,
      y: 420,
      expected: { kind: "folded-lane", laneId: "checkout", stage: "building" },
    },
    {
      name: "targets the head of a folded lane with no stage, so the card keeps its own",
      x: 60,
      y: 420,
      expected: { kind: "folded-lane", laneId: "checkout", stage: null },
    },
  ];

  it.each(cases)("$name", ({ x, y, expected }) => {
    expect(chooseDropPlace(GEOMETRY, x, y)).toEqual(expected);
  });

  it("keeps a drop below the last row of a closed long cell on that row, not behind its more line", () => {
    const closed: CellBox = { ...cellWithMiddles(150, 200, 250, 300), lastIndex: 3 };
    const geometry: BoardGeometry = {
      ...GEOMETRY,
      lanes: [openLane("storefront", 100, 400, { building: closed })],
    };

    // The cell has four rows, so the last place a drop may take is in front of the last row.
    expect(chooseDropPlace(geometry, 520, 395)).toEqual({
      kind: "cell",
      laneId: "storefront",
      stage: "building",
      beforeCardId: "card-3",
    });
    expect(chooseDropPlace(geometry, 520, 210)).toMatchObject({ beforeCardId: "card-2" });
  });

  it("finds no place on a board with no lane", () => {
    expect(chooseDropPlace({ ...GEOMETRY, lanes: [] }, 520, 300)).toBeNull();
  });
});

describe("isSameDropPlace", () => {
  const place: DropPlace = {
    kind: "cell",
    laneId: "storefront",
    stage: "building",
    beforeCardId: "card-1",
  };

  it("tells places apart by lane, stage and row, and a folded lane by lane and stage", () => {
    expect(isSameDropPlace(place, { ...place })).toBe(true);
    expect(isSameDropPlace(place, { ...place, beforeCardId: "card-2" })).toBe(false);
    expect(isSameDropPlace(place, { ...place, stage: "planned" })).toBe(false);
    expect(isSameDropPlace(place, { ...place, laneId: "checkout" })).toBe(false);
    expect(
      isSameDropPlace(place, { kind: "folded-lane", laneId: "storefront", stage: "building" }),
    ).toBe(false);
    expect(isSameDropPlace(null, null)).toBe(true);
    expect(isSameDropPlace(place, null)).toBe(false);
  });
});

describe("toBoardPoint", () => {
  it("turns a window position into a place on the board, so a scroll moves the pointer over the board", () => {
    const view = { left: 100, top: 50, bottom: 850, scrollLeft: 0, scrollTop: 0 };

    expect(toBoardPoint(view, 300, 250)).toEqual({ x: 200, y: 200 });
    expect(toBoardPoint({ ...view, scrollLeft: 30, scrollTop: 400 }, 300, 250)).toEqual({
      x: 230,
      y: 600,
    });
  });
});

describe("computeEdgeScrollSpeed", () => {
  it("is 0 clear of both edges, negative near the top, positive near the bottom, and faster the deeper in", () => {
    expect(computeEdgeScrollSpeed(400, 0, 800)).toBe(0);
    expect(computeEdgeScrollSpeed(100, 0, 800)).toBeLessThan(0);
    expect(computeEdgeScrollSpeed(10, 0, 800)).toBeLessThan(computeEdgeScrollSpeed(100, 0, 800));
    expect(computeEdgeScrollSpeed(760, 0, 800)).toBeGreaterThan(0);
    expect(computeEdgeScrollSpeed(799, 0, 800)).toBeGreaterThan(
      computeEdgeScrollSpeed(760, 0, 800),
    );
  });

  it("measures the edges from the board's own top and bottom", () => {
    expect(computeEdgeScrollSpeed(300, 200, 900)).toBeLessThan(0);
    expect(computeEdgeScrollSpeed(300, 0, 900)).toBe(0);
  });
});
