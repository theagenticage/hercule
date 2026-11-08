/** Tests the lanes as the board draws them: what each cell shows, the failed count, the dots, and the counts over the stages. */
import { describe, expect, it } from "vitest";
import {
  arrangeLanes,
  buildCellId,
  buildStackId,
  countCardsByStage,
  listDrawnLanes,
} from "./arrange-lanes";
import { buildBoard, buildCard, FAILURE, QUESTION } from "./cards.testing";
import { groupBoardByProject } from "./initiative-lanes";
import { buildLanes } from "./lanes";

const PROJECTS = [{ id: "storefront", name: "Storefront" }];
const CLOSED: Parameters<typeof arrangeLanes>[1] = {
  foldedLaneIds: new Set<string>(),
  openedCellIds: new Set<string>(),
  openedInitiativeIds: new Set<string>(),
  openedStackIds: new Set<string>(),
  stackCandidates: [],
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

describe("arrangeLanes with a stack", () => {
  const STACK_CANDIDATES = [
    { leadTaskId: "ticket", memberTaskId: "pr1", noun: "pull request" },
    { leadTaskId: "ticket", memberTaskId: "pr2", noun: "pull request" },
  ];
  const withStack = { ...CLOSED, stackCandidates: STACK_CANDIDATES };
  const cards = [
    buildCard("ticket", { projectId: "storefront" }),
    buildCard("pr1", { projectId: "storefront" }),
    buildCard("pr2", { projectId: "storefront" }),
    buildCard("alone", { projectId: "storefront" }),
  ];
  const readCell = (view: typeof CLOSED, among = cards) =>
    arrangeLanes(buildLanes(buildBoard(...among), PROJECTS), view)[0]!.cells.find(
      (cell) => cell.stage === "exploring",
    )!;

  it("draws the members of a closed stack nowhere", () => {
    const cell = readCell(withStack);

    expect(cell.shownCards.map((card) => card.id)).toEqual(["ticket", "alone"]);
    expect(cell.openStackLeadIds.size).toBe(0);
    expect(cell.cardCount).toBe(4);
  });

  it("draws the members right after their lead once the user opened the stack", () => {
    const cell = readCell({
      ...withStack,
      openedStackIds: new Set([buildStackId("storefront", "ticket")]),
    });

    expect(cell.shownCards.map((card) => card.id)).toEqual(["ticket", "pr1", "pr2", "alone"]);
    expect([...cell.openStackLeadIds]).toEqual(["ticket"]);
  });

  it("opens by itself when a member has a question, whatever the user chose", () => {
    const cell = readCell(withStack, [
      cards[0]!,
      buildCard("pr1", { projectId: "storefront", openQuestion: QUESTION }),
      cards[2]!,
      cards[3]!,
    ]);

    expect(cell.shownCards.map((card) => card.id)).toEqual(["ticket", "pr1", "pr2", "alone"]);
  });

  it("keeps the opened state of a stack in one lane apart from the same lead in another", () => {
    const cell = readCell({
      ...withStack,
      openedStackIds: new Set([buildStackId("other", "ticket")]),
    });

    expect(cell.openStackLeadIds.size).toBe(0);
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

describe("arrangeLanes with Initiative rows", () => {
  const PLATFORM = { id: "platform", name: "Platform", hue: 245 as const };
  const board = {
    ...buildBoard(
      buildCard("open", { initiativeId: "platform" }),
      buildCard("broke", { initiativeId: "platform", failure: FAILURE, stage: "building" }),
      buildCard("loose", { projectId: "storefront" }),
    ),
    initiativeDoneCounts: { platform: 1 },
  };
  const rowLanes = groupBoardByProject(board, PROJECTS, [PLATFORM], {
    place: "top",
    isFiltering: false,
  });
  const arrange = (view: Partial<Parameters<typeof arrangeLanes>[1]> = {}) =>
    arrangeLanes(rowLanes, { ...CLOSED, ...view })[0]!;

  it("folds a row unless its Initiative is opened", () => {
    expect(arrange().isFolded).toBe(true);
    expect(arrange({ openedInitiativeIds: new Set(["platform"]) }).isFolded).toBe(false);
  });

  it("does not fold a row because a lane with the same id is in foldedLaneIds while no filter is on", () => {
    const row = arrange({ openedInitiativeIds: new Set(["platform"]) });
    const folded = arrange({
      openedInitiativeIds: new Set(["platform"]),
      foldedLaneIds: new Set([row.lane.id]),
    });
    expect(folded.isFolded).toBe(false);
  });

  it("opens a row while a filter is on, and the user can fold it again by hand", () => {
    const row = arrange({ isFiltering: true });
    expect(row.isFolded).toBe(false);
    expect(arrange({ isFiltering: true, foldedLaneIds: new Set([row.lane.id]) }).isFolded).toBe(
      true,
    );
  });

  it("folds a Project lane by foldedLaneIds only", () => {
    const lane = arrangeLanes(rowLanes, { ...CLOSED, foldedLaneIds: new Set(["storefront"]) })[1]!;
    expect(lane.isFolded).toBe(true);
    expect(lane.line).toBeUndefined();
  });

  it("carries the beads of a row, folded or open, with its failed count", () => {
    for (const row of [arrange(), arrange({ openedInitiativeIds: new Set(["platform"]) })]) {
      expect(row.failedCount).toBe(1);
      expect(row.line?.reachStageIndex).toBe(4);
      expect(row.line?.cells.map((cell) => cell.beads.map((bead) => bead.taskId))).toEqual([
        ["open"],
        [],
        ["broke"],
        [],
        [null],
      ]);
    }
  });

  it("draws the cards of an open row as it draws any cell", () => {
    const row = arrange({ openedInitiativeIds: new Set(["platform"]) });
    expect(row.cells[0]?.shownCards.map((card) => card.id)).toEqual(["open"]);
    expect(row.cells[2]?.dot).toBe("failed");
  });

  it("leaves out the rows under a folded Project lane, and keeps the rows under an open one", () => {
    const underLanes = groupBoardByProject(
      board,
      PROJECTS,
      [{ ...PLATFORM, projectId: "storefront" }],
      {
        place: "lanes",
        isFiltering: false,
      },
    );
    const names = (foldedLaneIds: readonly string[]) =>
      listDrawnLanes(
        arrangeLanes(underLanes, { ...CLOSED, foldedLaneIds: new Set(foldedLaneIds) }),
        false,
      ).map((each) => each.lane.name);

    expect(names([])).toEqual(["Storefront", "Platform"]);
    expect(names(["storefront"])).toEqual(["Storefront"]);
  });

  it("leaves out the rows On top while their block is folded, and keeps the lanes", () => {
    const arranged = arrangeLanes(rowLanes, CLOSED);

    expect(listDrawnLanes(arranged, false).map((each) => each.lane.name)).toEqual([
      "Platform",
      "Storefront",
    ]);
    expect(listDrawnLanes(arranged, true).map((each) => each.lane.name)).toEqual(["Storefront"]);
  });
});

describe("a Project lane with Initiative rows under it", () => {
  const PLATFORM = { id: "platform", name: "Platform", hue: 245 as const, projectId: "storefront" };
  const board = {
    ...buildBoard(
      buildCard("loose-q", { projectId: "storefront", stage: "planned", openQuestion: QUESTION }),
      buildCard("row-a", { projectId: "storefront", initiativeId: "platform", stage: "building" }),
      buildCard("row-broke", {
        projectId: "storefront",
        initiativeId: "platform",
        stage: "planned",
        failure: FAILURE,
      }),
      buildCard("row-b", { projectId: "storefront", initiativeId: "platform", stage: "building" }),
    ),
    initiativeDoneCounts: {},
  };
  const place = (placement: "lanes" | "top") =>
    arrangeLanes(
      groupBoardByProject(board, PROJECTS, [PLATFORM], { place: placement, isFiltering: false }),
      CLOSED,
    );
  const findLane = (arranged: ReturnType<typeof place>, id: string) =>
    arranged.find((each) => each.lane.id === id)!;

  it("counts every Task of the Project in its head, folded counts, dots and failures, In lanes", () => {
    const storefront = findLane(place("lanes"), "storefront");

    expect(storefront.cardCountWithRows).toBe(4);
    expect(storefront.failedCount).toBe(1);
    expect(storefront.cells.map((cell) => cell.cardCountWithRows)).toEqual([0, 2, 2, 0, 0]);
    expect(storefront.cells.map((cell) => cell.dot)).toEqual([null, "failed", null, null, null]);
    expect(storefront.cells.map((cell) => cell.cardCount)).toEqual([0, 1, 0, 0, 0]);
  });

  it("draws no card twice: the lane's own cells hold only the loose cards", () => {
    const storefront = findLane(place("lanes"), "storefront");

    expect(storefront.cells.flatMap((cell) => cell.shownCards.map((card) => card.id))).toEqual([
      "loose-q",
    ]);
  });

  it("counts only the loose cards of a lane while the rows are On top", () => {
    const storefront = findLane(place("top"), "storefront");

    expect(storefront.cardCountWithRows).toBe(1);
    expect(storefront.failedCount).toBe(0);
    expect(storefront.cells.map((cell) => cell.cardCountWithRows)).toEqual([0, 1, 0, 0, 0]);
    expect(storefront.cells[1]?.dot).toBe("question");
  });

  it("counts a row by its own cards", () => {
    const row = findLane(place("lanes"), "initiative-row:platform");

    expect(row.cardCountWithRows).toBe(3);
    expect(row.failedCount).toBe(1);
  });
});
