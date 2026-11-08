/**
 * Tests which changes of a read the board holds back for a still hand, and
 * that everything else shows at once.
 */
import { describe, expect, it } from "vitest";
import { applyCardMove } from "./card-move";
import { buildBoard, buildCard, buildPlace, FAILURE, listIds } from "./cards.testing";
import { holdBackBoardChanges, buildArrivalKey } from "./hold-back-board";

const NOTHING = new Set<string>();

describe("holdBackBoardChanges", () => {
  it("returns the shown board itself when the read changed nothing", () => {
    const shown = buildBoard(buildCard("a"), buildCard("b"));
    const latest = buildBoard(buildCard("a"), buildCard("b"));

    const result = holdBackBoardChanges(shown, latest, NOTHING, NOTHING);

    expect(result.board).toBe(shown);
    expect(result.held).toEqual([]);
  });

  it("leaves out a Task that arrived, and says it is held", () => {
    const shown = buildBoard(buildCard("a"));
    const latest = buildBoard(buildCard("a"), buildCard("new"));

    const result = holdBackBoardChanges(shown, latest, NOTHING, NOTHING);

    expect(listIds(result.board.cards)).toEqual(["a"]);
    expect(result.held).toEqual([{ kind: "arrival", cardId: "new", key: "arrival:new" }]);
  });

  it("shows at once a card that comes back after the user's own gesture hid it", () => {
    // A merge held for the undo line took "b" off the board, and Undo brings it back.
    const shown = buildBoard(buildCard("a"));
    const latest = buildBoard(buildCard("a"), buildCard("b"));

    const result = holdBackBoardChanges(shown, latest, NOTHING, new Set(["b"]));

    expect(listIds(result.board.cards)).toEqual(["a", "b"]);
    expect(result.held).toEqual([]);
  });

  it("shows the Task that arrived once its arrival is released", () => {
    const shown = buildBoard(buildCard("a"));
    const latest = buildBoard(buildCard("a"), buildCard("new"));

    const result = holdBackBoardChanges(shown, latest, new Set([buildArrivalKey("new")]), NOTHING);

    expect(listIds(result.board.cards)).toEqual(["a", "new"]);
    expect(result.held).toEqual([]);
  });

  it("keeps the failing card as it was shown, in its place, until the failure is released", () => {
    const shown = buildBoard(buildCard("a"), buildCard("b"));
    const latest = buildBoard(buildCard("a"), buildCard("b", { failure: FAILURE }));

    const result = holdBackBoardChanges(shown, latest, NOTHING, NOTHING);

    expect(result.board.cards[1]!.failure).toBeUndefined();
    expect(result.held).toEqual([{ kind: "failure", cardId: "b", key: "failure:run-1" }]);

    const released = holdBackBoardChanges(shown, latest, new Set(["failure:run-1"]), NOTHING);
    expect(released.board.cards[1]!.failure).toEqual(FAILURE);
    expect(released.held).toEqual([]);
  });

  it("keeps a card the user moved in its new place while its failure is held", () => {
    const shown = buildBoard(
      buildCard("a", { stage: "building" }),
      buildCard("b", { stage: "building" }),
    );
    const latest = buildBoard(
      buildCard("a", { stage: "building" }),
      buildCard("b", { stage: "in-review", failure: FAILURE }),
    );

    const result = holdBackBoardChanges(shown, latest, NOTHING, NOTHING);

    expect(result.board.cards[1]).toMatchObject({ id: "b", stage: "in-review" });
    expect(result.board.cards[1]!.failure).toBeUndefined();
    expect(result.held).toEqual([{ kind: "failure", cardId: "b", key: "failure:run-1" }]);
  });

  it("holds a second failure of the same Task even after the first was released", () => {
    const shown = buildBoard(buildCard("b"));
    const latest = buildBoard(buildCard("b", { failure: { ...FAILURE, runId: "run-2" } }));

    const result = holdBackBoardChanges(shown, latest, new Set(["failure:run-1"]), NOTHING);

    expect(result.held.map((change) => change.key)).toEqual(["failure:run-2"]);
  });

  it("shows other changes at once while it holds a failure back", () => {
    const shown = buildBoard(buildCard("a"), buildCard("b"));
    const latest = buildBoard(
      buildCard("a", { stage: "building" }),
      buildCard("b", { failure: FAILURE }),
    );

    const result = holdBackBoardChanges(shown, latest, NOTHING, NOTHING);

    expect(result.board.cards[0]!.stage).toBe("building");
    expect(result.board.cards[1]!.failure).toBeUndefined();
  });

  it("does not hold a failure the board already showed, or a Task that left", () => {
    const shown = buildBoard(buildCard("a", { failure: FAILURE }), buildCard("gone"));
    const latest = buildBoard(buildCard("a", { failure: FAILURE }));

    const result = holdBackBoardChanges(shown, latest, NOTHING, NOTHING);

    expect(listIds(result.board.cards)).toEqual(["a"]);
    expect(result.held).toEqual([]);
  });

  it("shows a changed place and context flag at once, even when no card changed", () => {
    const shown = { ...buildBoard(buildCard("a")), places: [buildPlace("acme:r", "Old")] };
    const latest = {
      ...buildBoard(buildCard("a")),
      places: [buildPlace("acme:r", "New")],
      contextComplete: false,
    };

    const result = holdBackBoardChanges(shown, latest, NOTHING, NOTHING);

    expect(result.board.places[0]!.title).toBe("New");
    expect(result.board.contextComplete).toBe(false);
  });

  it("shows a changed place while it holds a Task that arrived", () => {
    const shown = { ...buildBoard(buildCard("a")), places: [buildPlace("acme:r", "Old")] };
    const latest = {
      ...buildBoard(buildCard("a"), buildCard("new")),
      places: [buildPlace("acme:r", "New")],
    };

    const result = holdBackBoardChanges(shown, latest, NOTHING, NOTHING);

    expect(listIds(result.board.cards)).toEqual(["a"]);
    expect(result.board.places[0]!.title).toBe("New");
    expect(result.held).toHaveLength(1);
  });

  describe("a card moved by a fact", () => {
    const OPENED = { ref: "github:pull-request:6221", text: "PR #6221 opened" };
    const MERGED = { ref: "github:pull-request:6221", text: "PR #6221 merged" };
    const AT_NOON = "2026-11-02T12:00:00.000Z";
    const FACT_KEY = `fact:b:${AT_NOON}`;

    /** Returns the cards of one stage of a board, in the order the lanes would draw them. */
    const listStage = (board: ReturnType<typeof buildBoard>, stage: string): readonly string[] =>
      listIds(board.cards.filter((card) => card.stage === stage));

    it("keeps the card in its shown stage and place until its fact is released", () => {
      const shown = buildBoard(
        buildCard("a", { stage: "in-review" }),
        buildCard("b", { stage: "in-review" }),
        buildCard("c", { stage: "in-review" }),
      );
      const latest = buildBoard(
        buildCard("a", { stage: "in-review" }),
        buildCard("c", { stage: "in-review" }),
        buildCard("b", { stage: "landed", stageCause: MERGED, stageChangedAt: AT_NOON }),
      );

      const result = holdBackBoardChanges(shown, latest, NOTHING, NOTHING);

      expect(result.board).toBe(shown);
      expect(result.held).toEqual([{ kind: "fact", cardId: "b", key: FACT_KEY }]);

      const released = holdBackBoardChanges(shown, latest, new Set([FACT_KEY]), NOTHING);
      expect(released.board).toEqual(latest);
      expect(released.held).toEqual([]);
    });

    it("keeps the cause the card is shown with, and shows other changes of the card at once", () => {
      const shown = buildBoard(buildCard("b", { stage: "in-review", stageCause: OPENED }));
      const latest = buildBoard(
        buildCard("b", {
          title: "Renamed",
          stage: "landed",
          stageCause: MERGED,
          stageChangedAt: AT_NOON,
        }),
      );

      const result = holdBackBoardChanges(shown, latest, NOTHING, NOTHING);

      expect(result.board.cards[0]).toEqual({
        ...shown.cards[0],
        title: "Renamed",
      });
    });

    it("keeps the card in the cell it was shown in when others of the cell moved too", () => {
      const shown = buildBoard(
        buildCard("x", { stage: "building" }),
        buildCard("b", { stage: "building" }),
        buildCard("y", { stage: "building" }),
      );
      const latest = buildBoard(
        buildCard("x", { stage: "building" }),
        buildCard("y", { stage: "building" }),
        buildCard("b", { stage: "landed", stageCause: MERGED, stageChangedAt: AT_NOON }),
      );

      const result = holdBackBoardChanges(shown, latest, NOTHING, NOTHING);

      expect(listStage(result.board, "building")).toEqual(["x", "b", "y"]);
      expect(listStage(result.board, "landed")).toEqual([]);
    });

    it("shows a stage change with no new cause at once", () => {
      // A drag from another client, or an undo: the stage changes and the cause stays as it was.
      const shown = buildBoard(buildCard("b", { stage: "in-review", stageCause: OPENED }));
      const dragged = buildBoard(buildCard("b", { stage: "building", stageCause: OPENED }));
      const cleared = buildBoard(buildCard("b", { stage: "building" }));

      expect(holdBackBoardChanges(shown, dragged, NOTHING, NOTHING)).toEqual({
        board: dragged,
        held: [],
      });
      expect(holdBackBoardChanges(shown, cleared, NOTHING, NOTHING)).toEqual({
        board: cleared,
        held: [],
      });
    });

    it("shows a new cause at once when the stage is the same", () => {
      const shown = buildBoard(buildCard("b", { stage: "in-review", stageCause: OPENED }));
      const latest = buildBoard(buildCard("b", { stage: "in-review", stageCause: MERGED }));

      expect(holdBackBoardChanges(shown, latest, NOTHING, NOTHING).held).toEqual([]);
    });

    it("shows at once the move the user made over a card that has a cause", () => {
      // The user drags the card while the board still has its cause: the logical board drops it.
      const shown = buildBoard(buildCard("b", { stage: "landed", stageCause: MERGED }));
      const latest = applyCardMove(shown, { taskId: "b", stage: "building" });

      const result = holdBackBoardChanges(shown, latest, NOTHING, NOTHING);

      expect(result.board.cards[0]!.stage).toBe("building");
      expect(result.held).toEqual([]);
    });

    it("is not released by anything but its own key", () => {
      const shown = buildBoard(buildCard("b", { stage: "in-review" }));
      const latest = buildBoard(
        buildCard("b", { stage: "landed", stageCause: MERGED, stageChangedAt: AT_NOON }),
      );
      const others = new Set([buildArrivalKey("b"), "failure:run-1", "fact:b:other"]);

      const result = holdBackBoardChanges(shown, latest, others, new Set(["b"]));

      expect(result.held.map((change) => change.key)).toEqual([FACT_KEY]);
    });

    it("holds a second fact for the same card after the first was released", () => {
      const reopened = {
        stage: "in-review",
        stageCause: OPENED,
        stageChangedAt: "2026-11-02T15:00:00.000Z",
      } as const;
      const shown = buildBoard(
        buildCard("b", { stage: "landed", stageCause: MERGED, stageChangedAt: AT_NOON }),
      );
      const latest = buildBoard(buildCard("b", reopened));

      const result = holdBackBoardChanges(shown, latest, new Set([FACT_KEY]), NOTHING);

      expect(result.board).toBe(shown);
      expect(result.held).toEqual([
        { kind: "fact", cardId: "b", key: "fact:b:2026-11-02T15:00:00.000Z" },
      ]);
    });

    it("holds both the fact and the failure of a card, and releases them apart", () => {
      const shown = buildBoard(buildCard("b", { stage: "in-review" }));
      const latest = buildBoard(
        buildCard("b", {
          stage: "landed",
          stageCause: MERGED,
          stageChangedAt: AT_NOON,
          failure: FAILURE,
        }),
      );

      const both = holdBackBoardChanges(shown, latest, NOTHING, NOTHING);
      expect(both.held.map((change) => change.kind)).toEqual(["failure", "fact"]);
      expect(both.board).toBe(shown);

      const failureShown = holdBackBoardChanges(shown, latest, new Set(["failure:run-1"]), NOTHING);
      expect(failureShown.board.cards[0]).toMatchObject({ stage: "in-review", failure: FAILURE });
      expect(failureShown.held.map((change) => change.kind)).toEqual(["fact"]);
    });
  });
});
