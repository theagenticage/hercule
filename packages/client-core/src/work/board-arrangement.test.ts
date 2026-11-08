/**
 * Tests the Work board as the screen draws it: which lanes and rows there
 * are, which a fold hides, what is counted and which words go under a row.
 */
import { describe, expect, it } from "vitest";
import type { WorkBoard } from "@hercule/contract";
import { buildBoardFolds } from "./board-folds";
import { arrangeTestBoard, buildBoard, buildCard, FAILURE, QUESTION } from "./cards.testing";
import { INITIATIVE_FACET_ID, PROJECT_FACET_ID } from "./facets";
import { NO_INITIATIVE_LANE_ID } from "./initiative-lanes";
import { NO_PROJECT_LANE_ID } from "./lanes";

const PROJECTS = [
  { id: "storefront", name: "Storefront" },
  { id: "checkout", name: "Checkout" },
];
const PLATFORM = { id: "platform", name: "Platform", hue: 245 as const, projectId: "storefront" };
const LAUNCH = { id: "launch", name: "Spring launch", hue: 150 as const };
const ORPHAN = { id: "orphan", name: "Old plans", hue: 300 as const, projectId: "deleted" };
const INITIATIVES = [PLATFORM, LAUNCH, ORPHAN];

const BOARD: WorkBoard = {
  ...buildBoard(
    buildCard("loose", { projectId: "storefront", stage: "planned", openQuestion: QUESTION }),
    buildCard("loose-gone", { projectId: "deleted-project" }),
    buildCard("co", { projectId: "checkout" }),
    buildCard("p-a", { projectId: "storefront", initiativeId: "platform", stage: "building" }),
    buildCard("p-broke", {
      projectId: "storefront",
      initiativeId: "platform",
      stage: "planned",
      failure: FAILURE,
    }),
    buildCard("p-landed", { initiativeId: "platform", stage: "landed" }),
    buildCard("l-1", { initiativeId: "launch" }),
  ),
  initiativeDoneCounts: { platform: 1 },
};

/** Returns the ids of the lanes the arrangement draws, each Project lane followed by its rows. */
const listDrawnLaneIds = (board: ReturnType<typeof arrangeTestBoard>): readonly string[] =>
  board.drawnLanes.map((each) => each.lane.id);

const arrange = (
  overrides: Parameters<typeof arrangeTestBoard>[1] = {},
  board: WorkBoard = BOARD,
) => arrangeTestBoard(board, { projects: PROJECTS, initiatives: INITIATIVES, ...overrides });

describe("arrangeBoard containers", () => {
  it("puts the rows On top in the block, and the Project lanes after it", () => {
    const arranged = arrange({ place: "top" });

    expect(arranged.groupBy).toBe(PROJECT_FACET_ID);
    expect(arranged.block?.rows.map((row) => row.lane.id)).toEqual([
      "initiative-row:platform",
      "initiative-row:launch",
      "initiative-row:orphan",
    ]);
    expect(arranged.lanes.map((each) => each.lane.id)).toEqual([
      "checkout",
      "storefront",
      NO_PROJECT_LANE_ID,
    ]);
    expect(arranged.lanes.flatMap((each) => each.rows)).toEqual([]);
  });

  it("puts each row under the lane of its Project In lanes, and has no block", () => {
    const arranged = arrange({ place: "lanes" });

    expect(arranged.block).toBeNull();
    expect(
      arranged.lanes.map((each) => [each.lane.id, each.rows.map((row) => row.lane.id)]),
    ).toEqual([
      ["checkout", []],
      ["storefront", ["initiative-row:platform"]],
      [NO_PROJECT_LANE_ID, ["initiative-row:launch", "initiative-row:orphan"]],
    ]);
  });

  it("draws the row of an Initiative whose Project is deleted in No project", () => {
    const arranged = arrange({ place: "lanes", initiatives: [ORPHAN] });

    expect(arranged.findLane(NO_PROJECT_LANE_ID)?.rows.map((row) => row.lane.id)).toEqual([
      "initiative-row:orphan",
    ]);
    expect(arranged.lanes.flatMap((each) => each.rows)).toHaveLength(1);
  });

  it("draws the same row instance in the container and in the flat lists", () => {
    const arranged = arrange({ place: "lanes" });
    const row = arranged.lanes.flatMap((each) => each.rows)[0];

    expect(row).toBeDefined();
    expect(arranged.everyLane).toContain(row);
    expect(arranged.drawnLanes).toContain(row);
    expect(arranged.findLane("initiative-row:platform")).toBe(row);
  });

  it("draws plain lanes, with no row, for Group by Initiative", () => {
    const arranged = arrange({ requestedGroupBy: INITIATIVE_FACET_ID });

    expect(arranged.groupBy).toBe(INITIATIVE_FACET_ID);
    expect(arranged.block).toBeNull();
    expect(arranged.lanes.map((each) => each.lane.id)).toEqual([
      "initiative:platform",
      "initiative:launch",
      "initiative:orphan",
      NO_INITIATIVE_LANE_ID,
    ]);
    expect(arranged.lanes.flatMap((each) => each.rows)).toEqual([]);
  });

  it("draws Project instead of a grouping the board does not have, or of Initiative once none is open", () => {
    expect(arrange({ requestedGroupBy: "acme/project" }).groupBy).toBe(PROJECT_FACET_ID);
    expect(arrange({ requestedGroupBy: INITIATIVE_FACET_ID, initiatives: [] }).groupBy).toBe(
      PROJECT_FACET_ID,
    );
  });
});

describe("arrangeBoard folds", () => {
  it("shows the rows folded and the lanes open by default", () => {
    const arranged = arrange({ place: "lanes" });

    expect(arranged.everyLane.map((each) => [each.lane.id, each.isFolded])).toEqual([
      ["checkout", false],
      ["storefront", false],
      ["initiative-row:platform", true],
      [NO_PROJECT_LANE_ID, false],
      ["initiative-row:launch", true],
      ["initiative-row:orphan", true],
    ]);
  });

  it("leaves out of the drawn lanes the rows under a folded lane, and keeps the lane", () => {
    const folds = buildBoardFolds({ saved: { foldedLaneIds: ["storefront"] } });
    const arranged = arrange({ place: "lanes", folds });

    expect(listDrawnLaneIds(arranged)).toEqual([
      "checkout",
      "storefront",
      NO_PROJECT_LANE_ID,
      "initiative-row:launch",
      "initiative-row:orphan",
    ]);
    expect(arranged.findLane("initiative-row:platform")).toBeDefined();
    expect(arranged.findLane("storefront")?.heldInitiatives).toEqual([
      { id: "platform", hue: 245, name: "Platform" },
    ]);
  });

  it("leaves out of the drawn lanes the rows On top while their block is folded, and keeps the lanes", () => {
    const folds = buildBoardFolds({ saved: { isInitiativeBlockFolded: true } });
    const arranged = arrange({ place: "top", folds });

    expect(arranged.block?.isFolded).toBe(true);
    expect(arranged.block?.rows).toHaveLength(3);
    expect(listDrawnLaneIds(arranged)).toEqual(["checkout", "storefront", NO_PROJECT_LANE_ID]);
  });

  it("opens the rows and the block while a filter is on, whatever was saved", () => {
    const folds = buildBoardFolds({
      isFiltering: true,
      saved: { isInitiativeBlockFolded: true, foldedLaneIds: ["storefront"] },
    });
    const arranged = arrange({ place: "top", folds });

    expect(arranged.block?.isFolded).toBe(false);
    expect(arranged.everyLane.every((each) => !each.isFolded)).toBe(true);
  });

  it("keeps the top block folded while filtering only when the user folded it since the filter came on", () => {
    const folds = buildBoardFolds({
      isFiltering: true,
      sinceFilter: { isInitiativeBlockFolded: true },
    });
    const arranged = arrange({
      place: "top",
      folds,
      visibleCards: BOARD.cards.filter((card) => card.initiativeId === "launch"),
    });

    expect(arranged.block?.rows.map((row) => row.lane.id)).toEqual(["initiative-row:launch"]);
    expect(arranged.block?.isFolded).toBe(true);
    expect(listDrawnLaneIds(arranged)).toEqual([]);
  });

  it("opens a row that the user opened, and folds a lane in Group by Initiative", () => {
    const folds = buildBoardFolds({
      saved: { openedInitiativeIds: ["platform"], foldedLaneIds: ["initiative:launch"] },
    });
    const onTop = arrange({ place: "top", folds });
    const byInitiative = arrange({ requestedGroupBy: INITIATIVE_FACET_ID, folds });

    expect(onTop.findLane("initiative-row:platform")?.isFolded).toBe(false);
    expect(byInitiative.findLane("initiative:launch")?.isFolded).toBe(true);
    expect(byInitiative.findLane("initiative:platform")?.isFolded).toBe(false);
  });
});

describe("arrangeBoard filtering", () => {
  const filtering = buildBoardFolds({ isFiltering: true });

  it("drops the rows and lanes that nothing matches, and draws no Done ring", () => {
    const arranged = arrange({
      place: "lanes",
      folds: filtering,
      visibleCards: BOARD.cards.filter((card) => card.id === "p-a"),
    });

    expect(arranged.lanes.map((each) => each.lane.id)).toEqual(["storefront"]);
    expect(arranged.lanes[0]?.rows.map((row) => row.lane.id)).toEqual(["initiative-row:platform"]);
    expect(arranged.lanes[0]?.rows[0]?.line?.cells.at(-1)?.beads).toEqual([]);
  });

  it("counts the stages from the cards the filter leaves", () => {
    const arranged = arrange({
      folds: filtering,
      visibleCards: BOARD.cards.filter((card) => card.stage === "building"),
    });

    expect(arranged.stageCounts).toEqual({
      exploring: 0,
      planned: 0,
      building: 1,
      "in-review": 0,
      landed: 0,
    });
  });

  it("says no lane when the filter leaves nothing", () => {
    const arranged = arrange({ place: "top", folds: filtering, visibleCards: [] });

    expect(arranged.block).toBeNull();
    expect(arranged.lanes).toEqual([]);
    expect(arranged.drawnLanes).toEqual([]);
    expect(arranged.isEmpty).toBe(false);
  });
});

describe("arrangeBoard counts", () => {
  it("counts every Task of the Project in its head In lanes, with dots and failures from its rows", () => {
    const storefront = arrange({ place: "lanes" }).findLane("storefront")!;

    expect(storefront.cardCountWithRows).toBe(4);
    expect(storefront.failedCount).toBe(1);
    expect(storefront.cells.map((cell) => cell.cardCountWithRows)).toEqual([0, 2, 1, 0, 1]);
    expect(storefront.cells.map((cell) => cell.dot)).toEqual([null, "failed", null, null, null]);
    expect(storefront.cells.map((cell) => cell.cardCount)).toEqual([0, 1, 0, 0, 0]);
  });

  it("draws no card twice: the lane's own cells hold only the loose cards", () => {
    const storefront = arrange({ place: "lanes" }).findLane("storefront")!;

    expect(storefront.cells.flatMap((cell) => cell.shownCards.map((card) => card.id))).toEqual([
      "loose",
    ]);
  });

  it("counts only the loose cards of a lane while the rows are On top", () => {
    const storefront = arrange({ place: "top" }).findLane("storefront")!;

    expect(storefront.cardCountWithRows).toBe(1);
    expect(storefront.failedCount).toBe(0);
    expect(storefront.cells[1]?.dot).toBe("question");
  });

  it("counts a row by its own cards, and carries its beads, folded or open", () => {
    for (const folds of [
      buildBoardFolds(),
      buildBoardFolds({ saved: { openedInitiativeIds: ["platform"] } }),
    ]) {
      const row = arrange({ place: "top", folds }).findLane("initiative-row:platform")!;

      expect(row.cardCountWithRows).toBe(3);
      expect(row.failedCount).toBe(1);
      expect(row.line?.cells.map((cell) => cell.beads.length)).toEqual([0, 1, 1, 0, 2]);
    }
  });

  it("counts every Task at each stage once, shown or not, whatever the folds", () => {
    const folds = buildBoardFolds({
      saved: { foldedLaneIds: ["storefront"], isInitiativeBlockFolded: true },
    });
    const arranged = arrange({ place: "top", folds });

    expect(arranged.stageCounts).toEqual({
      exploring: 3,
      planned: 2,
      building: 1,
      "in-review": 0,
      landed: 1,
    });
  });

  it("has no stage counts until the board is drawn", () => {
    expect(arrange({ drawnBoard: undefined }).stageCounts).toBeNull();
  });
});

describe("arrangeBoard facts", () => {
  it("counts progress from the logical board, never from the cards the filter leaves", () => {
    const filtered = arrange({
      place: "top",
      folds: buildBoardFolds({ isFiltering: true }),
      visibleCards: BOARD.cards.filter((card) => card.id === "p-a"),
    });

    expect(filtered.factsByInitiativeId.get("platform")).toBe("Storefront · 2 of 4 landed");
    expect(filtered.factsByInitiativeId.has("launch")).toBe(false);
    expect(arrange({ place: "top" }).factsByInitiativeId.get("launch")).toBe("0 of 1 landed");
  });

  it("counts a Task the logical board has marked Done, which the drawn board still holds", () => {
    const logicalBoard = {
      cards: BOARD.cards.filter((card) => card.id !== "p-a"),
      initiativeDoneCounts: { platform: 2 },
    };

    expect(arrange({ logicalBoard }).factsByInitiativeId.get("platform")).toBe(
      "Storefront · 3 of 4 landed",
    );
  });

  it("leaves out the Project's name In lanes, where the lane says it", () => {
    expect(arrange({ place: "lanes" }).factsByInitiativeId.get("platform")).toBe("2 of 4 landed");
  });

  it("tells no fact until the logical board is read", () => {
    expect(arrange({ logicalBoard: undefined }).factsByInitiativeId.size).toBe(0);
  });
});

describe("arrangeBoard isEmpty", () => {
  const EMPTY = buildBoard();

  it("is empty when the board is drawn and has no card and no Initiative", () => {
    expect(arrange({ initiatives: [] }, EMPTY).isEmpty).toBe(true);
  });

  it("is not empty with an empty Initiative, which still draws its row", () => {
    const arranged = arrange({ initiatives: [LAUNCH] }, EMPTY);

    expect(arranged.isEmpty).toBe(false);
    expect(arranged.block?.rows.map((row) => row.lane.id)).toEqual(["initiative-row:launch"]);
  });

  it("is empty with an Initiative the grouping does not draw", () => {
    const arranged = arrange({ initiatives: [LAUNCH], requestedGroupBy: "acme/project" }, EMPTY);

    expect(arranged.groupBy).toBe(PROJECT_FACET_ID);
    expect(arranged.isEmpty).toBe(false);
  });

  it("is not empty until the board is drawn", () => {
    expect(arrange({ drawnBoard: undefined, initiatives: [] }, EMPTY).isEmpty).toBe(false);
  });

  it("is not empty with a card, though the filter leaves none", () => {
    expect(arrange({ initiatives: [], visibleCards: [] }).isEmpty).toBe(false);
  });
});

describe("arrangeBoard walk", () => {
  it("lists the shown cards in drawing order, leaving out those of a folded row", () => {
    const folds = buildBoardFolds({ saved: { openedInitiativeIds: ["platform"] } });
    const arranged = arrange({ place: "top", folds });

    expect(arranged.shownCards.map((card) => card.cardId)).toEqual([
      "p-broke",
      "p-a",
      "co",
      "loose",
      "loose-gone",
    ]);
  });

  it("finds a lane or a hidden row by id, and nothing for an unknown id", () => {
    const folds = buildBoardFolds({ saved: { isInitiativeBlockFolded: true } });
    const arranged = arrange({ place: "top", folds });

    expect(arranged.findLane("initiative-row:launch")?.lane.name).toBe("Spring launch");
    expect(arranged.findLane("storefront")?.lane.name).toBe("Storefront");
    expect(arranged.findLane("nowhere")).toBeUndefined();
  });
});
