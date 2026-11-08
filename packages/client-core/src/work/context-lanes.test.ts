/**
 * Tests Group by an outside context: the rows of the menu, the lanes of one
 * grouping, and a Task under two places.
 */
import { describe, expect, it } from "vitest";
import type { WorkBoard } from "@hercule/contract";
import { buildBoardFolds } from "./board-folds";
import { buildBoard, buildCard, buildPlace, listIds } from "./cards.testing";
import { groupBoardByContext, listBoardGroupings, listContextLaneIds } from "./context-lanes";
import { countCardsByStage, arrangeLanes } from "./arrange-lanes";

const GROUPING = { kind: "acme/project", caption: "Acme project" };

/** Returns a board of these cards over the given places, groupable by `acme/project`. */
const buildContextBoard = (
  cards: WorkBoard["cards"],
  places: WorkBoard["places"],
  groupings: WorkBoard["groupings"] = [GROUPING],
): WorkBoard => ({ ...buildBoard(...cards), places, groupings });

const PLACES = [
  buildPlace("acme:project:returns", "Returns at the depots", {
    status: { shape: "half", tone: "active", label: "In progress" },
    progress: { fraction: 0.43, done: 6, total: 14 },
  }),
  buildPlace("acme:project:pricing", "Pricing rules"),
];

describe("listBoardGroupings", () => {
  it("lists the groupable kinds with their captions and plugin, ordered by caption", () => {
    const board = {
      groupings: [
        { kind: "relay/repository", caption: "Relay repository" },
        { kind: "acme/team", caption: "Acme team" },
      ],
    };
    expect(listBoardGroupings(board)).toEqual([
      { kind: "acme/team", caption: "Acme team", pluginId: "acme" },
      { kind: "relay/repository", caption: "Relay repository", pluginId: "relay" },
    ]);
  });
});

describe("groupBoardByContext", () => {
  it("makes one lane per place with a card, by name, and a last lane for what has none", () => {
    const board = buildContextBoard(
      [
        buildCard("a", { contextRefs: ["acme:project:returns"] }),
        buildCard("b", { contextRefs: ["acme:project:pricing"] }),
        buildCard("c"),
      ],
      PLACES,
    );
    const lanes = groupBoardByContext(board, "acme/project");
    expect(lanes.map((lane) => lane.name)).toEqual([
      "Pricing rules",
      "Returns at the depots",
      "No Acme project",
    ]);
    expect(lanes.map((lane) => listIds(lane.cells[0]?.cards ?? []))).toEqual([["b"], ["a"], ["c"]]);
    expect(lanes.every((lane) => lane.projectId === null)).toBe(true);
  });

  it("leaves out a place with no card and the last lane when every Task has a place", () => {
    const board = buildContextBoard(
      [buildCard("a", { contextRefs: ["acme:project:returns"] })],
      PLACES,
    );
    expect(groupBoardByContext(board, "acme/project").map((lane) => lane.id)).toEqual([
      "place:acme:project:returns",
    ]);
  });

  it("gives a lane the mark of the plugin, and what the place says about itself", () => {
    const board = buildContextBoard(
      [buildCard("a", { contextRefs: ["acme:project:returns"] }), buildCard("b")],
      PLACES,
    );
    const [place, none] = groupBoardByContext(board, "acme/project");
    expect(place?.outside).toMatchObject({
      pluginId: "acme",
      caption: "Acme project",
      status: { label: "In progress" },
      progress: { fraction: 0.43, done: 6, total: 14 },
    });
    expect(none?.outside).toEqual({ pluginId: null, caption: "Acme project", cardPlaces: {} });
  });

  it("shows no progress for a place whose source reports none", () => {
    const board = buildContextBoard(
      [buildCard("a", { contextRefs: ["acme:project:pricing"] })],
      PLACES,
    );
    expect(groupBoardByContext(board, "acme/project")[0]?.outside).not.toHaveProperty("progress");
  });

  describe("a Task under two places", () => {
    const board = buildContextBoard(
      [
        buildCard("both", { contextRefs: ["acme:project:returns", "acme:project:pricing"] }),
        buildCard("one", { contextRefs: ["acme:project:pricing"] }),
        buildCard("late", { stage: "building", contextRefs: ["acme:project:pricing"] }),
      ],
      PLACES,
    );
    const lanes = groupBoardByContext(board, "acme/project");

    it("has a card in each lane, saying in how many places with their names", () => {
      expect(lanes.map((lane) => listIds(lane.cells[0]?.cards ?? []))).toEqual([
        ["both", "one"],
        ["both"],
      ]);
      const expected = {
        summary: "In 2 projects",
        names: ["Pricing rules", "Returns at the depots"],
      };
      expect(lanes.map((lane) => lane.outside?.cardPlaces)).toEqual([
        { both: expected },
        { both: expected },
      ]);
    });

    it("is counted once in the stage headers", () => {
      const arranged = arrangeLanes(lanes, {
        folds: buildBoardFolds(),
        openedCellIds: new Set(),
        openedStackIds: new Set(),
        stackCandidates: [],
      });
      expect(countCardsByStage(arranged)).toMatchObject({ exploring: 2, building: 1 });
    });
  });

  it("matches through contextRefs only, so a peer's ancestors never count", () => {
    // The server leaves a peer's ancestors out of contextRefs. An edge on the board does not
    // give the card a place by itself.
    const board: WorkBoard = {
      ...buildContextBoard([buildCard("peer", { contextRefs: ["acme:issue:1"] })], PLACES),
      edges: [{ fromRef: "acme:issue:1", toRef: "acme:project:returns" }],
    };
    expect(groupBoardByContext(board, "acme/project").map((lane) => lane.name)).toEqual([
      "No Acme project",
    ]);
  });

  it("uses a plain name for a place the user cannot open", () => {
    const board = buildContextBoard(
      [buildCard("a", { contextRefs: ["acme:project:secret"] })],
      [{ ref: "acme:project:secret", kind: "acme/project", noun: "Project", restricted: true }],
    );
    expect(groupBoardByContext(board, "acme/project")[0]?.name).toBe("A project you cannot open");
  });

  it("starts the plain name with an for a noun that starts with a vowel", () => {
    const board = buildContextBoard(
      [buildCard("a", { contextRefs: ["acme:project:secret"] })],
      [{ ref: "acme:project:secret", kind: "acme/project", noun: "Initiative", restricted: true }],
    );
    expect(groupBoardByContext(board, "acme/project")[0]?.name).toBe(
      "An initiative you cannot open",
    );
  });

  it("makes no lane for a kind the board cannot group by", () => {
    const board = buildContextBoard([buildCard("a")], PLACES, []);
    expect(groupBoardByContext(board, "acme/project")).toEqual([]);
  });

  it("pluralizes the noun of a kind that ends in y", () => {
    const places = ["a", "b"].map((word) =>
      buildPlace(`relay:repo:${word}`, `Repo ${word}`, {
        kind: "relay/repository",
        noun: "Repository",
      }),
    );
    const board = buildContextBoard(
      [buildCard("x", { contextRefs: ["relay:repo:a", "relay:repo:b"] })],
      places,
      [{ kind: "relay/repository", caption: "Relay repository" }],
    );
    const [lane] = groupBoardByContext(board, "relay/repository");
    expect(lane?.outside?.cardPlaces["x"]?.summary).toBe("In 2 repositories");
  });
});

describe("listContextLaneIds", () => {
  it("names the lanes that groupBoardByContext draws for each card", () => {
    const cards = [
      buildCard("both", { contextRefs: ["acme:project:returns", "acme:project:pricing"] }),
      buildCard("one", { contextRefs: ["acme:project:pricing"] }),
      buildCard("none"),
      buildCard("elsewhere", { contextRefs: ["acme:project:unknown"] }),
    ];
    const board = buildContextBoard(cards, PLACES);
    const lanes = groupBoardByContext(board, "acme/project");
    for (const card of cards) {
      const drawnIn = lanes
        .filter((lane) => lane.cells.some((cell) => cell.cards.includes(card)))
        .map((lane) => lane.id);
      expect(listContextLaneIds(card, board.places, "acme/project").toSorted()).toEqual(
        drawnIn.toSorted(),
      );
    }
  });
});
