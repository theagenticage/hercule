/** Tests walking the board with the keys, over what is on screen. */
import { describe, expect, it } from "vitest";
import type { BoardStage } from "@hercule/contract";
import { arrangeLanes, buildStackId } from "./arrange-lanes";
import { buildBoard, buildCard, buildPlace } from "./cards.testing";
import { groupBoardByContext } from "./context-lanes";
import { groupBoardByProject } from "./initiative-lanes";
import { buildLanes } from "./lanes";
import { walkBoard, type BoardWalk, type WalkStop } from "./walk";

const PROJECTS = [
  { id: "cart", name: "Cart" },
  { id: "delivery", name: "Delivery" },
  { id: "returns", name: "Returns" },
  { id: "storefront", name: "Storefront" },
];

/** Returns a card of `id` in the lane `projectId` at `stage`. */
const at = (id: string, projectId: string, stage: BoardStage) =>
  buildCard(id, { projectId, stage });

/**
 * Four lanes of five columns (Exploring to Landed), in the order of their names.
 *
 *   cart:        [a1 a2 a3] [ ]      [b1]      [ ]  [ ]
 *   delivery:    [x]        [ ]      [ ]       [ ]  [ ]      (folded)
 *   returns:     [c1]       [c2 c3]  [ ]       [ ]  [d1 d2]
 *   storefront:  [ ]        [ ]      [ ]       [ ]  [e]      (open, but "1 landed" hides e)
 */
const LANES = arrangeLanes(
  buildLanes(
    buildBoard(
      at("a1", "cart", "exploring"),
      at("a2", "cart", "exploring"),
      at("a3", "cart", "exploring"),
      at("b1", "cart", "building"),
      at("x", "delivery", "exploring"),
      at("c1", "returns", "exploring"),
      at("c2", "returns", "planned"),
      at("c3", "returns", "planned"),
      {
        ...at("d1", "returns", "landed"),
        openQuestion: { sessionId: "s", requestId: "r", text: "?" },
      },
      {
        ...at("d2", "returns", "landed"),
        openQuestion: { sessionId: "s", requestId: "r", text: "?" },
      },
      at("e", "storefront", "landed"),
    ),
    PROJECTS,
  ),
  {
    foldedLaneIds: new Set(["delivery"]),
    openedCellIds: new Set<string>(),
    openedInitiativeIds: new Set<string>(),
    openedStackIds: new Set<string>(),
    stackCandidates: [],
    isFiltering: false,
  },
);

/** Returns the card `cardId` in the lane it stands in on this board. "gone" is on no lane. */
const card = (cardId: string): WalkStop => ({
  kind: "card",
  cardId,
  laneId:
    LANES.find((lane) =>
      lane.cells.some((cell) => cell.arrangement.cards.some((each) => each.id === cardId)),
    )?.lane.id ?? "cart",
});
const head = (laneId: string): WalkStop => ({ kind: "lane", laneId });

describe("walkBoard over stacks", () => {
  const cards = [
    buildCard("ticket", { projectId: "cart", stage: "exploring" }),
    buildCard("pr1", { projectId: "cart", stage: "exploring" }),
    buildCard("pr2", { projectId: "cart", stage: "exploring" }),
    buildCard("after", { projectId: "cart", stage: "exploring" }),
    buildCard("beside", { projectId: "cart", stage: "planned" }),
  ];
  const view = (isOpen: boolean) =>
    arrangeLanes(buildLanes(buildBoard(...cards), PROJECTS), {
      foldedLaneIds: new Set<string>(),
      openedCellIds: new Set<string>(),
      openedInitiativeIds: new Set<string>(),
      openedStackIds: new Set(isOpen ? [buildStackId("cart", "ticket")] : []),
      stackCandidates: [
        { leadTaskId: "ticket", memberTaskId: "pr1", noun: "pull request" },
        { leadTaskId: "ticket", memberTaskId: "pr2", noun: "pull request" },
      ],
      isFiltering: false,
    });
  const stop = (cardId: string): WalkStop => ({ kind: "card", laneId: "cart", cardId });

  it("goes down through the members of an open stack, then on to the next card", () => {
    const lanes = view(true);

    expect(walkBoard(lanes, stop("ticket"), "down")).toEqual(stop("pr1"));
    expect(walkBoard(lanes, stop("pr1"), "down")).toEqual(stop("pr2"));
    expect(walkBoard(lanes, stop("pr2"), "down")).toEqual(stop("after"));
    expect(walkBoard(lanes, stop("after"), "up")).toEqual(stop("pr2"));
  });

  it("skips the members of a closed stack, which are not on screen", () => {
    const lanes = view(false);

    expect(walkBoard(lanes, stop("ticket"), "down")).toEqual(stop("after"));
    expect(walkBoard(lanes, stop("after"), "up")).toEqual(stop("ticket"));
    // A member that is not drawn is not a place to start from.
    expect(walkBoard(lanes, stop("pr1"), "down")).toEqual(stop("ticket"));
  });
});

describe("walkBoard", () => {
  it.each<[string, WalkStop, BoardWalk, WalkStop | undefined]>([
    ["down inside a column", card("a1"), "down", card("a2")],
    ["up inside a column", card("a3"), "up", card("a2")],
    ["up from the top of a column with nothing above", card("a1"), "up", undefined],
    [
      "down from the bottom of a column, passing over the folded lane",
      card("a3"),
      "down",
      card("c1"),
    ],
    ["up from the top of a column, passing over the folded lane", card("c1"), "up", card("a3")],
    ["down from the last card of the last lane with cards", card("c3"), "down", undefined],
    ["down from a column that no lane below has a card in", card("b1"), "down", undefined],
    ["right skips empty columns, to the same row", card("a2"), "right", card("b1")],
    [
      "right lands on the last row when the next column is shorter",
      card("a3"),
      "right",
      card("b1"),
    ],
    ["left lands on the nearest row", card("d2"), "left", card("c3")],
    ["left from the first column stays", card("a1"), "left", undefined],
    ["right from the last column stays", card("d1"), "right", undefined],
    ["right never leaves the lane", card("b1"), "right", undefined],
    ["next lane stops on a folded lane", card("a2"), "nextLane", head("delivery")],
    [
      "next lane from a folded lane goes to the first card of the lane below",
      head("delivery"),
      "nextLane",
      card("c1"),
    ],
    ["previous lane stops on a folded lane", card("c2"), "previousLane", head("delivery")],
    [
      "previous lane from a folded lane goes to the first card above",
      head("delivery"),
      "previousLane",
      card("a1"),
    ],
    [
      "next lane from the last lane with cards stays, passing over an open lane that shows none",
      card("c2"),
      "nextLane",
      undefined,
    ],
    ["previous lane from the first lane stays", card("b1"), "previousLane", undefined],
    ["a folded lane head has no card to go down from", head("delivery"), "down", undefined],
    ["a card hidden behind a line is not on screen", card("e"), "left", card("a1")],
  ])("%s", (_, from, walk, expected) => {
    expect(walkBoard(LANES, from, walk)).toEqual(expected);
  });

  it("starts at the first card when nothing, or a card not shown, has focus", () => {
    expect(walkBoard(LANES, undefined, "down")).toEqual(card("a1"));
    expect(walkBoard(LANES, card("gone"), "left")).toEqual(card("a1"));
  });

  it("starts a lane walk at the first stop, which may be a folded lane", () => {
    const foldedFirst = [LANES[1]!, LANES[0]!];

    expect(walkBoard(foldedFirst, undefined, "nextLane")).toEqual(head("delivery"));
  });

  it("goes nowhere on a board with no card on screen", () => {
    expect(walkBoard([LANES[3]!], undefined, "down")).toBeUndefined();
  });

  describe("with a Task under two outside places", () => {
    const place = (ref: string, title: string) => buildPlace(ref, title);
    const board = {
      ...buildBoard(
        buildCard("t1", { contextRefs: ["acme:a", "acme:b"], stage: "exploring" }),
        buildCard("t2", { contextRefs: ["acme:b"], stage: "exploring" }),
      ),
      places: [place("acme:a", "Alpha"), place("acme:b", "Beta")],
      groupings: [{ kind: "acme/project", caption: "Acme project" }],
    };
    const shown = arrangeLanes(groupBoardByContext(board, "acme/project"), {
      foldedLaneIds: new Set<string>(),
      openedCellIds: new Set<string>(),
      openedInitiativeIds: new Set<string>(),
      openedStackIds: new Set<string>(),
      stackCandidates: [],
      isFiltering: false,
    });
    const inLane = (laneId: string, cardId: string): WalkStop => ({ kind: "card", laneId, cardId });

    it("walks down from the copy in the second lane, not from the first", () => {
      expect(walkBoard(shown, inLane("place:acme:b", "t1"), "down")).toEqual(
        inLane("place:acme:b", "t2"),
      );
      expect(walkBoard(shown, inLane("place:acme:a", "t1"), "down")).toEqual(
        inLane("place:acme:b", "t1"),
      );
    });

    it("walks up from the second lane's copy into the first lane's", () => {
      expect(walkBoard(shown, inLane("place:acme:b", "t1"), "up")).toEqual(
        inLane("place:acme:a", "t1"),
      );
    });
  });
});

describe("walkBoard over Initiative rows", () => {
  const PLATFORM = { id: "platform", name: "Platform", hue: 245 as const };
  const board = {
    ...buildBoard(
      buildCard("p1", { initiativeId: "platform" }),
      buildCard("p2", { initiativeId: "platform" }),
      buildCard("loose"),
    ),
    initiativeDoneCounts: {},
  };
  const rows = (opened: readonly string[]) =>
    arrangeLanes(
      groupBoardByProject(board, PROJECTS, [PLATFORM], { place: "top", isFiltering: false }),
      {
        foldedLaneIds: new Set<string>(),
        openedCellIds: new Set<string>(),
        openedInitiativeIds: new Set(opened),
        openedStackIds: new Set<string>(),
        stackCandidates: [],
        isFiltering: false,
      },
    );

  it("walks into an open row like into a lane, down to the lane below", () => {
    const lanes = rows(["platform"]);
    const row = lanes[0]!.lane.id;
    expect(walkBoard(lanes, undefined, "down")).toEqual({
      kind: "card",
      laneId: row,
      cardId: "p1",
    });
    expect(walkBoard(lanes, { kind: "card", laneId: row, cardId: "p2" }, "down")).toEqual({
      kind: "card",
      laneId: "no-project",
      cardId: "loose",
    });
  });

  it("stops on the head of a folded row, which shows no card", () => {
    const lanes = rows([]);
    expect(walkBoard(lanes, undefined, "nextLane")).toEqual({
      kind: "lane",
      laneId: lanes[0]!.lane.id,
    });
  });
});
