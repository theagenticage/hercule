/**
 * Tests the lanes of the board: their order, the cells in stage order, the
 * stored order of the cards, and where a card of a missing Project stands.
 */
import { describe, expect, it } from "vitest";
import { BOARD_STAGES } from "@hercule/contract";
import { buildBoard, buildCard, listIds } from "./cards.testing";
import { buildLanes, NO_PROJECT_LANE_ID } from "./lanes";

const PROJECTS = [
  { id: "p-pricing", name: "Pricing rules" },
  { id: "p-depots", name: "Depot returns" },
  { id: "p-baskets", name: "basket sync" },
];

describe("buildLanes", () => {
  it("sorts lanes by project name, ignoring the order given, with No project last", () => {
    const board = buildBoard(
      buildCard("loose"),
      buildCard("a", { projectId: "p-pricing" }),
      buildCard("b", { projectId: "p-depots" }),
      buildCard("c", { projectId: "p-baskets" }),
    );
    const lanes = buildLanes(board, PROJECTS);
    expect(lanes.map((lane) => lane.name)).toEqual([
      "basket sync",
      "Depot returns",
      "Pricing rules",
      "No project",
    ]);
    expect(lanes.at(-1)).toMatchObject({ id: NO_PROJECT_LANE_ID, projectId: null });
    expect(lanes[0]).toMatchObject({ id: "p-baskets", projectId: "p-baskets" });
  });

  it("leaves out a lane with no card, and has no No project lane when nothing is loose", () => {
    const lanes = buildLanes(buildBoard(buildCard("a", { projectId: "p-depots" })), PROJECTS);
    expect(lanes.map((lane) => lane.id)).toEqual(["p-depots"]);
  });

  it("gives every lane five cells in stage order", () => {
    const [lane] = buildLanes(buildBoard(buildCard("a", { projectId: "p-depots" })), PROJECTS);
    expect(lane?.cells.map((cell) => cell.stage)).toEqual([...BOARD_STAGES]);
  });

  it("keeps the order of the board inside a cell, whatever the ranks say", () => {
    // A card the client moved keeps its old rank, so the list order is the order.
    const board = buildBoard(
      buildCard("moved", { projectId: "p-depots", stage: "building", boardRank: "z" }),
      buildCard("first", { projectId: "p-depots", stage: "building", boardRank: "a" }),
      buildCard("other-stage", { projectId: "p-depots", stage: "planned" }),
    );
    const [lane] = buildLanes(board, PROJECTS);
    const building = lane?.cells.find((cell) => cell.stage === "building");
    expect(listIds(building?.cards ?? [])).toEqual(["moved", "first"]);
  });

  it("puts a card whose Project is missing, as when it was deleted, under No project", () => {
    const board = buildBoard(buildCard("orphan", { projectId: "p-deleted" }), buildCard("loose"));
    const lanes = buildLanes(board, PROJECTS);
    expect(lanes.map((lane) => lane.id)).toEqual([NO_PROJECT_LANE_ID]);
    expect(listIds(lanes[0]?.cells[0]?.cards ?? [])).toEqual(["orphan", "loose"]);
  });
});
