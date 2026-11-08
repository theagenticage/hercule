/**
 * Tests where each card of the board stands once Initiatives exist: on an
 * Initiative row or lane, or in its Project lane. A card stands in exactly one
 * place.
 */
import { describe, expect, it } from "vitest";
import { buildBoard, buildCard, listIds } from "./cards.testing";
import {
  findCardInitiativeFlag,
  groupBoardByInitiative,
  groupBoardByProject,
  listLaneInitiatives,
  NO_INITIATIVE_LANE_ID,
} from "./initiative-lanes";
import { buildLanes, NO_PROJECT_LANE_ID, type WorkLane } from "./lanes";

const PROJECTS = [
  { id: "storefront", name: "Storefront" },
  { id: "checkout", name: "Checkout" },
];

const PLATFORM = { id: "platform", name: "Platform", hue: 245 as const, projectId: "storefront" };
const LAUNCH = { id: "launch", name: "Spring launch", hue: 150 as const };
const ORPHAN = { id: "orphan", name: "Old plans", hue: 300 as const, projectId: "deleted" };

const BOARD = {
  ...buildBoard(
    buildCard("loose-store", { projectId: "storefront" }),
    buildCard("loose-none"),
    buildCard("platform-store", { projectId: "storefront", initiativeId: "platform" }),
    buildCard("platform-check", {
      projectId: "checkout",
      initiativeId: "platform",
      stage: "building",
    }),
    buildCard("launch-1", { initiativeId: "launch" }),
    buildCard("closed", { projectId: "checkout", initiativeId: "closed-one" }),
  ),
  initiativeDoneCounts: { platform: 2, launch: 1 },
};

const TOP = { place: "top", isFiltering: false } as const;
const IN_LANES = { place: "lanes", isFiltering: false } as const;

/** Returns `lane id: card ids` for every lane, in the order drawn and the order of the stages. */
const describeLanes = (lanes: readonly WorkLane[]): Record<string, readonly string[]> =>
  Object.fromEntries(lanes.map((lane) => [lane.id, listIds(lane.cells.flatMap((c) => c.cards))]));

describe("groupBoardByProject", () => {
  it("returns the lanes buildLanes returns when there is no Initiative", () => {
    for (const view of [TOP, IN_LANES]) {
      expect(groupBoardByProject(BOARD, PROJECTS, [], view)).toEqual(buildLanes(BOARD, PROJECTS));
    }
  });

  it("draws the rows on top of the lanes, in the order of the list, and leaves their cards out of the lanes", () => {
    const lanes = groupBoardByProject(BOARD, PROJECTS, [LAUNCH, PLATFORM], TOP);
    expect(describeLanes(lanes)).toEqual({
      "initiative-row:launch": ["launch-1"],
      "initiative-row:platform": ["platform-store", "platform-check"],
      checkout: ["closed"],
      storefront: ["loose-store"],
      [NO_PROJECT_LANE_ID]: ["loose-none"],
    });
    expect(Object.keys(describeLanes(lanes)).slice(0, 2)).toEqual([
      "initiative-row:launch",
      "initiative-row:platform",
    ]);
  });

  it("describes a row on top with its Project's name, its hue and its Done rings", () => {
    const [launch, platform] = groupBoardByProject(BOARD, PROJECTS, [LAUNCH, PLATFORM], TOP);
    expect(platform).toMatchObject({
      name: "Platform",
      projectId: null,
      initiative: {
        initiativeId: "platform",
        hue: 245,
        isRow: true,
        projectName: "Storefront",
        doneRingCount: 2,
      },
    });
    expect(launch?.initiative).toEqual({
      initiativeId: "launch",
      hue: 150,
      isRow: true,
      doneRingCount: 1,
    });
  });

  it("draws a card whose Initiative is not listed, because it is closed, in its lane", () => {
    const lanes = groupBoardByProject(BOARD, PROJECTS, [PLATFORM], TOP);
    expect(describeLanes(lanes)["checkout"]).toEqual(["closed"]);
    expect(describeLanes(lanes)["initiative-row:launch"]).toBeUndefined();
  });

  it("draws every card in exactly one place", () => {
    for (const view of [TOP, IN_LANES]) {
      const lanes = groupBoardByProject(BOARD, PROJECTS, [LAUNCH, PLATFORM, ORPHAN], view);
      expect(
        lanes.flatMap((lane) => listIds(lane.cells.flatMap((c) => c.cards))).toSorted(),
      ).toEqual(listIds(BOARD.cards).toSorted());
    }
  });

  describe("in lanes", () => {
    it("puts each row under the lane of its Project, and No project for an Initiative with none or with an unlisted one", () => {
      const lanes = groupBoardByProject(BOARD, PROJECTS, [LAUNCH, PLATFORM, ORPHAN], IN_LANES);
      expect(lanes.map((lane) => lane.id)).toEqual([
        "checkout",
        "storefront",
        "initiative-row:platform",
        NO_PROJECT_LANE_ID,
        "initiative-row:launch",
        "initiative-row:orphan",
      ]);
      expect(lanes.find((lane) => lane.id === "initiative-row:platform")?.initiative).toEqual({
        initiativeId: "platform",
        hue: 245,
        isRow: true,
        underLaneId: "storefront",
        doneRingCount: 2,
      });
      expect(
        lanes.find((lane) => lane.id === "initiative-row:orphan")?.initiative?.underLaneId,
      ).toBe(NO_PROJECT_LANE_ID);
    });

    it("still draws a Project lane that holds only a row, and a row with no Task", () => {
      const board = buildBoard(
        buildCard("p", { projectId: "storefront", initiativeId: "platform" }),
      );
      const lanes = groupBoardByProject(board, PROJECTS, [PLATFORM, LAUNCH], IN_LANES);
      expect(describeLanes(lanes)).toEqual({
        storefront: [],
        "initiative-row:platform": ["p"],
        [NO_PROJECT_LANE_ID]: [],
        "initiative-row:launch": [],
      });
    });
  });

  describe("while filtering", () => {
    it("drops a row and a lane that nothing matches, and draws no Done ring", () => {
      const filtered = { ...BOARD, cards: BOARD.cards.filter((c) => c.id === "platform-check") };
      const view = { place: "lanes", isFiltering: true } as const;
      const lanes = groupBoardByProject(filtered, PROJECTS, [LAUNCH, PLATFORM], view);
      expect(lanes.map((lane) => lane.id)).toEqual(["storefront", "initiative-row:platform"]);
      expect(lanes[1]?.initiative?.doneRingCount).toBe(0);
    });

    it("drops the rows on top that nothing matches", () => {
      const filtered = { ...BOARD, cards: BOARD.cards.filter((c) => c.id === "launch-1") };
      const view = { place: "top", isFiltering: true } as const;
      expect(
        groupBoardByProject(filtered, PROJECTS, [PLATFORM, LAUNCH], view).map((lane) => lane.id),
      ).toEqual(["initiative-row:launch"]);
    });
  });
});

describe("groupBoardByInitiative", () => {
  const view = { isFiltering: false };

  it("draws a lane for each Initiative in list order, then Not in an initiative with the rest", () => {
    const lanes = groupBoardByInitiative(BOARD, [LAUNCH, PLATFORM], view);
    expect(describeLanes(lanes)).toEqual({
      "initiative:launch": ["launch-1"],
      "initiative:platform": ["platform-store", "platform-check"],
      [NO_INITIATIVE_LANE_ID]: ["loose-store", "loose-none", "closed"],
    });
    expect(lanes.map((lane) => lane.name)).toEqual([
      "Spring launch",
      "Platform",
      "Not in an initiative",
    ]);
  });

  it("draws lanes that are not rows, with the Initiative's hue and no Project", () => {
    const [launch, , rest] = groupBoardByInitiative(BOARD, [LAUNCH, PLATFORM], view);
    expect(launch).toMatchObject({
      projectId: null,
      initiative: { initiativeId: "launch", hue: 150, isRow: false, doneRingCount: 0 },
    });
    expect(rest?.initiative).toBeUndefined();
  });

  it("draws every Initiative's lane and the last lane even when empty, so a drop can land there", () => {
    const board = buildBoard(buildCard("p", { initiativeId: "platform" }));
    expect(groupBoardByInitiative(board, [PLATFORM, LAUNCH], view).map((lane) => lane.id)).toEqual([
      "initiative:platform",
      "initiative:launch",
      NO_INITIATIVE_LANE_ID,
    ]);
  });

  it("draws all cards in the last lane when no Initiative exists", () => {
    const lanes = groupBoardByInitiative(BOARD, [], view);
    expect(lanes.map((lane) => lane.id)).toEqual([NO_INITIATIVE_LANE_ID]);
    expect(listIds(lanes[0]!.cells.flatMap((cell) => cell.cards)).toSorted()).toEqual(
      listIds(BOARD.cards).toSorted(),
    );
  });

  it("draws nothing for an empty board with no Initiative", () => {
    expect(groupBoardByInitiative(buildBoard(), [], view)).toEqual([]);
  });

  it("drops the lanes that nothing matches while filtering", () => {
    const filtered = { cards: BOARD.cards.filter((c) => c.id === "launch-1") };
    expect(
      groupBoardByInitiative(filtered, [LAUNCH, PLATFORM], { isFiltering: true }).map(
        (lane) => lane.id,
      ),
    ).toEqual(["initiative:launch"]);
  });
});

describe("findCardInitiativeFlag", () => {
  const card = buildCard("a", { initiativeId: "platform" });

  it.each([
    ["Group by Project, where the row or the lane says it", "project", undefined],
    ["Group by Initiative", "initiative", PLATFORM],
    ["a grouping by an outside kind", "linear/project", PLATFORM],
  ])("under %s", (_, groupBy, flag) => {
    expect(findCardInitiativeFlag(card, groupBy, [PLATFORM])).toEqual(flag);
  });

  it("shows no flag for a card with no Initiative, or one that is not listed", () => {
    expect(findCardInitiativeFlag(buildCard("b"), "initiative", [PLATFORM])).toBeUndefined();
    expect(findCardInitiativeFlag(card, "initiative", [LAUNCH])).toBeUndefined();
  });
});

describe("listLaneInitiatives", () => {
  const view = { place: "lanes", isFiltering: false } as const;
  const rows = (initiatives: Parameters<typeof groupBoardByProject>[2]) =>
    groupBoardByProject(BOARD, PROJECTS, initiatives, view).map((lane) => ({ lane }));

  it("lists the Initiatives drawn under a lane, in the order of their rows", () => {
    expect(listLaneInitiatives(rows([PLATFORM, LAUNCH, ORPHAN]), "storefront")).toEqual([
      { id: "platform", hue: 245, name: "Platform" },
    ]);
    expect(listLaneInitiatives(rows([PLATFORM, LAUNCH, ORPHAN]), NO_PROJECT_LANE_ID)).toEqual([
      { id: "launch", hue: 150, name: "Spring launch" },
      { id: "orphan", hue: 300, name: "Old plans" },
    ]);
  });

  it("lists none for a lane that holds none, and none while the rows are On top", () => {
    expect(listLaneInitiatives(rows([PLATFORM]), "checkout")).toEqual([]);
    const onTop = groupBoardByProject(BOARD, PROJECTS, [PLATFORM], {
      place: "top",
      isFiltering: false,
    }).map((lane) => ({ lane }));
    expect(listLaneInitiatives(onTop, "storefront")).toEqual([]);
  });
});
