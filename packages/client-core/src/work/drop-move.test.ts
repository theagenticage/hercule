/**
 * Tests the move a drop asks for: which stage and Project it names, and which
 * card the dropped card follows in stored order.
 */
import { describe, expect, it } from "vitest";
import type { BoardStage } from "@hercule/contract";
import { arrangeLanes, type ArrangedLane } from "./arrange-lanes";
import { applyCardMove, type CardMove } from "./card-move";
import { buildBoardFolds } from "./board-folds";
import {
  arrangeTestBoard,
  buildBoard,
  buildCard,
  buildPlace,
  FAILURE,
  listIds,
} from "./cards.testing";
import { groupBoardByContext } from "./context-lanes";
import { buildDropMove, buildFollowerMoves, settleGroupDrop } from "./drop-move";
import { NO_INITIATIVE_LANE_ID } from "./initiative-lanes";
import { buildLanes } from "./lanes";
import { INITIATIVE_FACET_ID } from "./facets";

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

/**
 * Drops the card `movingCardId` of `cards` on the lane `laneId` at `stage`,
 * in front of the card `beforeCardId` (`null` for last), on the lanes as the
 * board draws them. `foldedLaneId` names a lane the user folded.
 */
const buildDrop = (
  movingCardId: string,
  laneId: string,
  stage: BoardStage | null,
  beforeCardId: string | null,
  {
    cards = CARDS,
    foldedLaneId,
    followerIds,
  }: { cards?: typeof CARDS; foldedLaneId?: string; followerIds?: readonly string[] } = {},
) => {
  const lane = arrangeLanes(buildLanes({ cards }, PROJECTS), {
    folds: buildBoardFolds({
      saved: { foldedLaneIds: foldedLaneId === undefined ? [] : [foldedLaneId] },
    }),
    openedCellIds: new Set(),
    openedStackIds: new Set(),
    stackCandidates: [],
  }).find((each) => each.lane.id === laneId)!;
  return buildDropMove({
    movingCard: cards.find((card) => card.id === movingCardId)!,
    lane,
    stage,
    beforeCardId,
    listedInitiativeIds: new Set(),
    ...(followerIds === undefined ? {} : { followerIds }),
  });
};

/** Returns the move that dropping `movingCardId` on a lane asks for, with the arguments of `buildDrop`. */
const dropOn = (...args: Parameters<typeof buildDrop>) => buildDrop(...args).move;

describe("buildDropMove", () => {
  it("follows the card before the one the slot is in front of, and names no Project in the card's own lane", () => {
    expect(dropOn("a", "storefront", "building", null)).toEqual({
      taskId: "a",
      stage: "building",
      afterTaskId: "d",
    });
  });

  it("puts the card first in a cell when the slot is in front of the first card", () => {
    expect(dropOn("a", "storefront", "building", "d")).toEqual({
      taskId: "a",
      stage: "building",
      afterTaskId: null,
    });
  });

  it("leaves the moving card out when it reorders inside its own cell", () => {
    // Dropped in front of c: it now follows b.
    expect(dropOn("a", "storefront", "exploring", "c")).toEqual({
      taskId: "a",
      afterTaskId: "b",
    });
  });

  it("names the stage only when the card changes stage", () => {
    // The controller reads a stage in a move as the user's decision, so a reorder must not send one.
    expect(dropOn("a", "storefront", "exploring", "c")).not.toHaveProperty("stage");
    expect(dropOn("a", "storefront", "building", "d")).toHaveProperty("stage", "building");
    expect(buildDrop("a", "storefront", "exploring", "c").targetStage).toBe("exploring");
  });

  it("sends a move that leaves the order as it was for a drop on the card's own place", () => {
    const move = dropOn("b", "storefront", "exploring", "c");

    const after = applyCardMove(buildBoard(...CARDS), move);
    expect(listIds(after.cards)).toEqual(listIds(CARDS));
  });

  it("names the Project of the lane the card is let go on, also when the move leaves the Project out", () => {
    // In its own lane the move writes no Project, but a drop there still has a target to check.
    expect(buildDrop("a", "storefront", "building", null)).toMatchObject({
      move: { taskId: "a" },
      targetProjectId: "storefront",
    });
    expect(buildDrop("a", "checkout", "exploring", null).targetProjectId).toBe("checkout");
    expect(buildDrop("a", "no-project", "exploring", null).targetProjectId).toBeNull();
  });

  it("names the lane's Project when the card goes to another lane", () => {
    expect(dropOn("a", "checkout", "exploring", null)).toEqual({
      taskId: "a",
      projectId: "checkout",
      afterTaskId: "e",
    });
  });

  it("names no Project (null) when the card goes to the No project lane", () => {
    expect(dropOn("a", "no-project", "exploring", "f")).toEqual({
      taskId: "a",
      projectId: null,
      afterTaskId: null,
    });
  });

  it("sends a card that came from No project to a Project's lane with that Project", () => {
    expect(dropOn("f", "checkout", "planned", null)).toEqual({
      taskId: "f",
      stage: "planned",
      projectId: "checkout",
      afterTaskId: null,
    });
  });

  it("does not touch the Project of a card whose Project is gone when it is dropped in the lane it stands in", () => {
    const orphan = buildCard("orphan", { projectId: "deleted-project", stage: "exploring" });

    expect(dropOn("orphan", "no-project", "planned", null, { cards: [...CARDS, orphan] })).toEqual({
      taskId: "orphan",
      stage: "planned",
      afterTaskId: null,
    });
  });

  it("leaves afterTaskId out for a folded lane, and keeps the card's stage when the drop names none", () => {
    expect(dropOn("a", "checkout", null, null, { foldedLaneId: "checkout" })).toEqual({
      taskId: "a",
      projectId: "checkout",
    });
    expect(buildDrop("a", "checkout", null, null, { foldedLaneId: "checkout" }).targetStage).toBe(
      "exploring",
    );
    expect(dropOn("a", "checkout", "in-review", null, { foldedLaneId: "checkout" })).toEqual({
      taskId: "a",
      stage: "in-review",
      projectId: "checkout",
    });
  });

  it("goes before the first hidden card when the slot is after the last card a cell shows", () => {
    const crowded = [
      ...["m1", "m2", "m3", "m4", "m5", "m6"].map((id) =>
        buildCard(id, { projectId: "storefront", stage: "planned" }),
      ),
      buildCard("x", { projectId: "storefront", stage: "exploring" }),
    ];

    // The cell shows m1 to m4, and m5 and m6 wait behind "2 more".
    expect(dropOn("x", "storefront", "planned", null, { cards: crowded })).toEqual({
      taskId: "x",
      stage: "planned",
      afterTaskId: "m4",
    });
  });

  it("reads the stored order, not the order on screen, when a failed card leads the cell", () => {
    const withFailure = [
      buildCard("p", { projectId: "storefront", stage: "planned" }),
      buildCard("q", { projectId: "storefront", stage: "planned" }),
      buildCard("r", { projectId: "storefront", stage: "planned", failure: FAILURE }),
      buildCard("x", { projectId: "storefront", stage: "exploring" }),
    ];

    // On screen the cell reads r, p, q. Dropped in front of q, x follows p.
    expect(dropOn("x", "storefront", "planned", "q", { cards: withFailure })).toEqual({
      taskId: "x",
      stage: "planned",
      afterTaskId: "p",
    });
  });

  describe("in a lane for an outside place", () => {
    const board = {
      ...buildBoard(
        buildCard("a", { projectId: "storefront", contextRefs: ["acme:project:returns"] }),
        buildCard("b", {
          projectId: "storefront",
          stage: "building",
          contextRefs: ["acme:project:returns"],
        }),
        buildCard("c", { projectId: "checkout", stage: "building" }),
        buildCard("d", { projectId: "storefront", stage: "building" }),
      ),
      places: [buildPlace("acme:project:returns", "Returns at the depots")],
      groupings: [{ kind: "acme/project", caption: "Acme project" }],
    };
    const dropOnOutside = (laneId: string, beforeCardId: string | null, folded = false) => {
      const lane = arrangeLanes(groupBoardByContext(board, "acme/project"), {
        folds: buildBoardFolds({ saved: { foldedLaneIds: folded ? [laneId] : [] } }),
        openedCellIds: new Set(),
        openedStackIds: new Set(),
        stackCandidates: [],
      }).find((each) => each.lane.id === laneId)!;
      return buildDropMove({
        movingCard: board.cards[0]!,
        lane,
        stage: "building",
        beforeCardId,
        listedInitiativeIds: new Set(),
      });
    };

    it.each([
      ["a place", "place:acme:project:returns", "b"],
      ["a place, with no slot", "place:acme:project:returns", null],
      ["the lane for Tasks under none", "none:acme/project", null],
    ])("changes the stage only in %s", (_, laneId, beforeCardId) => {
      const drop = dropOnOutside(laneId, beforeCardId);
      expect(drop).toEqual({ move: { taskId: "a", stage: "building" }, targetStage: "building" });
    });

    it("changes the stage only on a folded lane too", () => {
      const drop = dropOnOutside("place:acme:project:returns", null, true);
      expect(drop.move).toEqual({ taskId: "a", stage: "building" });
    });

    it("changes the stage only for every card of a drop of several, and leaves each in its Project", () => {
      const drop = dropOnOutside("place:acme:project:returns", null);
      const followers = [board.cards[1]!, board.cards[2]!];

      const settled = settleGroupDrop(board, PROJECTS, drop, followers);

      expect(settled).toEqual({
        kind: "send",
        moves: [{ taskId: "a", stage: "building" }, { taskId: "b" }, { taskId: "c" }],
      });
      const moved = (settled as { moves: readonly CardMove[] }).moves.reduce(applyCardMove, board);
      expect(Object.fromEntries(moved.cards.map((card) => [card.id, card.projectId]))).toEqual({
        a: "storefront",
        b: "storefront",
        c: "checkout",
        d: "storefront",
      });
    });

    it("leaves the card in its Project, last in its stored cell", () => {
      const { move } = dropOnOutside("place:acme:project:returns", "b");
      const moved = applyCardMove(board, move);
      expect(moved.cards.find((card) => card.id === "a")?.projectId).toBe("storefront");
      expect(listIds(moved.cards)).toEqual(["b", "c", "d", "a"]);
    });
  });
});

describe("dropping several cards", () => {
  /** Drops `leadId` with the cards `followerIds` and returns the order of the cell it lands in. */
  const dropGroup = (
    leadId: string,
    followerIds: readonly string[],
    laneId: string,
    stage: BoardStage,
    beforeCardId: string | null,
    options: { foldedLaneId?: string } = {},
  ) => {
    const drop = buildDrop(leadId, laneId, stage, beforeCardId, { ...options, followerIds });
    const followers = followerIds.map((id) => CARDS.find((card) => card.id === id)!);
    const settled = settleGroupDrop({ cards: CARDS }, PROJECTS, drop, followers);
    if (settled.kind === "refuse") throw new Error(settled.reason);
    const after = settled.moves.reduce(applyCardMove, buildBoard(...CARDS));
    return {
      settled,
      cell: listIds(
        after.cards.filter(
          (card) => card.stage === stage && (card.projectId ?? null) === drop.targetProjectId,
        ),
      ),
    };
  };

  it("leaves the cards that travel out when it looks for the card to follow", () => {
    // Cell Exploring of Storefront is a, b, c. Dropping d in front of c, with b along: it follows a.
    expect(dropOn("d", "storefront", "exploring", "c", { followerIds: ["b"] })).toEqual({
      taskId: "d",
      stage: "exploring",
      afterTaskId: "a",
    });
  });

  it("lands the cards in order right after the lead card, whatever the cell held", () => {
    const { settled, cell } = dropGroup("a", ["c", "e"], "storefront", "building", null);

    expect(settled.moves.map((move) => move.afterTaskId)).toEqual(["d", "a", "c"]);
    expect(cell).toEqual(["d", "a", "c", "e"]);
  });

  it("names the Project only for the cards that stand in another one", () => {
    const { settled } = dropGroup("e", ["a", "f"], "checkout", "planned", null);

    expect(settled.moves).toEqual([
      { taskId: "e", stage: "planned", afterTaskId: null },
      { taskId: "a", stage: "planned", projectId: "checkout", afterTaskId: "e" },
      { taskId: "f", stage: "planned", projectId: "checkout", afterTaskId: "a" },
    ]);
  });

  it("names the stage only for the cards that change stage, also when the lead card does not", () => {
    // d is in Building, a and e in Exploring. Dropping d first in its own cell moves a and e into Building.
    const { settled } = dropGroup("d", ["a", "e"], "storefront", "building", null);
    expect(settled.moves).toEqual([
      { taskId: "d", afterTaskId: null },
      { taskId: "a", stage: "building", afterTaskId: "d" },
      { taskId: "e", stage: "building", projectId: "storefront", afterTaskId: "a" },
    ]);
  });

  it("sends the cards to the No project lane with a null Project", () => {
    const { settled } = dropGroup("f", ["a"], "no-project", "planned", null);

    expect(settled.moves[1]).toEqual({
      taskId: "a",
      stage: "planned",
      projectId: null,
      afterTaskId: "f",
    });
  });

  it("names no card to follow on a folded lane, so the cards go last in turn", () => {
    const { settled } = dropGroup("a", ["b", "c"], "checkout", "planned", null, {
      foldedLaneId: "checkout",
    });

    expect(settled.moves.map((move) => move.afterTaskId)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(settled.moves.map((move) => move.taskId)).toEqual(["a", "b", "c"]);
  });

  it("leaves a follower that left the board out, and says how many", () => {
    const drop = buildDrop("a", "storefront", "building", null, { followerIds: ["b", "c"] });
    const followers = [CARDS[1]!, CARDS[2]!];
    const board = { cards: CARDS.filter((card) => card.id !== "c") };

    const settled = settleGroupDrop(board, PROJECTS, drop, followers);

    expect(settled).toEqual({
      kind: "send",
      moves: [
        { taskId: "a", stage: "building", afterTaskId: "d" },
        { taskId: "b", stage: "building", afterTaskId: "a" },
      ],
      note: "1 of the selected Tasks had left the board, so it was not moved.",
    });
  });

  it("refuses the whole drop when the lead card has left the board", () => {
    const drop = buildDrop("a", "storefront", "building", null);
    const board = { cards: CARDS.filter((card) => card.id !== "a") };

    expect(settleGroupDrop(board, PROJECTS, drop, [CARDS[1]!])).toEqual({
      kind: "refuse",
      reason: "The Task has left the board, so it was not moved.",
    });
  });

  it("keeps the note of the lead card when the card it follows has gone", () => {
    const drop = buildDrop("a", "storefront", "building", null);
    const board = { cards: CARDS.filter((card) => card.id !== "d") };

    const settled = settleGroupDrop(board, PROJECTS, drop, [CARDS[1]!]);

    expect(settled).toMatchObject({
      kind: "send",
      moves: [
        { taskId: "a", afterTaskId: null },
        { taskId: "b", afterTaskId: "a" },
      ],
      note: "The card it followed has gone, so it went last in that stage.",
    });
  });
});

describe("buildFollowerMoves", () => {
  it("builds nothing for no followers", () => {
    expect(
      buildFollowerMoves({ move: { taskId: "a", stage: "planned" }, targetProjectId: null }, []),
    ).toEqual([]);
  });

  it("takes the target stage from the lead move when the drop carries none", () => {
    const moves = buildFollowerMoves({ move: { taskId: "a", stage: "building" } }, [
      CARDS[3]!,
      CARDS[1]!,
    ]);

    expect(moves).toEqual([{ taskId: "d" }, { taskId: "b", stage: "building" }]);
  });
});

describe("buildDropMove with Initiatives", () => {
  const PLATFORM = { id: "platform", name: "Platform", hue: 245 as const, projectId: "storefront" };
  const LAUNCH = { id: "launch", name: "Spring launch", hue: 150 as const };
  const INITIATIVES = [PLATFORM, LAUNCH];
  const LISTED = new Set(INITIATIVES.map((initiative) => initiative.id));

  const cards = [
    buildCard("loose", { projectId: "storefront" }),
    buildCard("other", { projectId: "checkout", stage: "planned" }),
    buildCard("on-platform", { projectId: "storefront", initiativeId: "platform" }),
    buildCard("on-platform-2", { projectId: "storefront", initiativeId: "platform" }),
    buildCard("on-launch", { projectId: "checkout", initiativeId: "launch", stage: "building" }),
    buildCard("on-closed", { projectId: "storefront", initiativeId: "closed-one" }),
  ];
  const board = { ...buildBoard(...cards), initiativeDoneCounts: {} };

  const dropOnLane = (
    lanes: readonly ArrangedLane[],
    movingCardId: string,
    laneId: string,
    stage: BoardStage | null,
    followerIds?: readonly string[],
  ) =>
    buildDropMove({
      movingCard: cards.find((card) => card.id === movingCardId)!,
      lane: lanes.find((each) => each.lane.id === laneId)!,
      stage,
      beforeCardId: null,
      listedInitiativeIds: LISTED,
      ...(followerIds === undefined ? {} : { followerIds }),
    });

  const onTop = arrangeTestBoard(board, { projects: PROJECTS, initiatives: INITIATIVES }).everyLane;
  const byInitiative = arrangeTestBoard(board, {
    projects: PROJECTS,
    initiatives: INITIATIVES,
    requestedGroupBy: INITIATIVE_FACET_ID,
  }).everyLane;

  it.each([
    [
      "a row, at a stage",
      onTop,
      "loose",
      "initiative-row:platform",
      "building",
      { taskId: "loose", stage: "building", initiativeId: "platform" },
    ],
    [
      "a row, keeping the stage",
      onTop,
      "loose",
      "initiative-row:platform",
      null,
      { taskId: "loose", initiativeId: "platform" },
    ],
    [
      "another row",
      onTop,
      "on-launch",
      "initiative-row:platform",
      "building",
      { taskId: "on-launch", initiativeId: "platform" },
    ],
    [
      "its own row, at another stage",
      onTop,
      "on-platform",
      "initiative-row:platform",
      "planned",
      { taskId: "on-platform", stage: "planned" },
    ],
    [
      "its own row, at its own stage",
      onTop,
      "on-platform",
      "initiative-row:platform",
      "exploring",
      { taskId: "on-platform" },
    ],
    [
      "a lane of Group by Initiative",
      byInitiative,
      "loose",
      "initiative:launch",
      "planned",
      { taskId: "loose", stage: "planned", initiativeId: "launch" },
    ],
    [
      "a card of a closed Initiative",
      onTop,
      "on-closed",
      "initiative-row:launch",
      null,
      { taskId: "on-closed", initiativeId: "launch" },
    ],
  ] as const)(
    "on %s names the stage and the Initiative, never a Project or a place",
    (_, lanes, id, laneId, stage, move) => {
      const drop = dropOnLane(lanes, id, laneId, stage);
      expect(drop.move).toEqual(move);
      expect(drop.targetProjectId).toBeUndefined();
    },
  );

  it.each([
    [
      "a Project lane, from a row",
      onTop,
      "on-launch",
      "storefront",
      {
        taskId: "on-launch",
        stage: "exploring",
        projectId: "storefront",
        initiativeId: null,
        afterTaskId: "on-closed",
      },
    ],
    [
      "Not in an initiative, from a row",
      byInitiative,
      "on-platform",
      NO_INITIATIVE_LANE_ID,
      { taskId: "on-platform", initiativeId: null },
    ],
    [
      "Not in an initiative, from a closed Initiative",
      byInitiative,
      "on-closed",
      NO_INITIATIVE_LANE_ID,
      { taskId: "on-closed" },
    ],
  ] as const)("on %s takes the card off its Initiative", (_, lanes, id, laneId, move) => {
    const drop = dropOnLane(lanes, id, laneId, "exploring");
    expect(drop.move).toMatchObject(move);
    if (laneId === NO_INITIATIVE_LANE_ID) expect(drop.move).toEqual(move);
  });

  it("leaves the Initiative of a card of a closed Initiative alone on a Project lane", () => {
    const drop = dropOnLane(onTop, "on-closed", "checkout", "exploring");
    expect(drop.move).not.toHaveProperty("initiativeId");
    expect(drop.move).toMatchObject({ projectId: "checkout" });
  });

  it("names no Initiative on a Project lane for a card that is on none, nor on its own lane", () => {
    expect(dropOnLane(onTop, "loose", "checkout", "exploring").move).not.toHaveProperty(
      "initiativeId",
    );
    expect(dropOnLane(onTop, "loose", "storefront", "planned").move).not.toHaveProperty(
      "initiativeId",
    );
  });

  it("gives the cards carried along the same treatment, by their own Initiative", () => {
    const drop = dropOnLane(byInitiative, "loose", "initiative:launch", "building", [
      "on-platform",
      "on-launch",
      "on-closed",
    ]);
    const followers = ["on-platform", "on-launch", "on-closed"].map((id) =>
      cards.find((card) => card.id === id)!,
    );
    expect(buildFollowerMoves(drop, followers)).toEqual([
      { taskId: "on-platform", stage: "building", initiativeId: "launch" },
      { taskId: "on-launch" },
      { taskId: "on-closed", stage: "building", initiativeId: "launch" },
    ]);
  });

  it("takes a follower off a listed Initiative on a Project lane, and keeps a closed one", () => {
    const drop = dropOnLane(onTop, "on-launch", "storefront", "exploring", [
      "on-platform",
      "on-closed",
    ]);
    const followers = ["on-platform", "on-closed"].map((id) =>
      cards.find((card) => card.id === id)!,
    );
    const [platform, closed] = buildFollowerMoves(drop, followers);
    expect(platform).toMatchObject({ taskId: "on-platform", initiativeId: null });
    expect(closed).not.toHaveProperty("initiativeId");
  });
});
