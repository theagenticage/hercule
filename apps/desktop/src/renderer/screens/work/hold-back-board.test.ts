/**
 * Tests which changes of a read the board holds back for a still hand, and
 * that everything else shows at once.
 */
import { describe, expect, it } from "vitest";
import { buildBoard, buildCard, FAILURE, listIds } from "@hercule/client-core/work/testing";
import { holdBackBoardChanges, buildArrivalKey } from "./hold-back-board";

const NOTHING = new Set<string>();

describe("holdBackBoardChanges", () => {
  it("returns the shown board itself when the read changed nothing", () => {
    const shown = buildBoard(buildCard("a"), buildCard("b"));
    const latest = buildBoard(buildCard("a"), buildCard("b"));

    const result = holdBackBoardChanges(shown, latest, NOTHING);

    expect(result.board).toBe(shown);
    expect(result.held).toEqual([]);
  });

  it("leaves out a Task that arrived, and says it is held", () => {
    const shown = buildBoard(buildCard("a"));
    const latest = buildBoard(buildCard("a"), buildCard("new"));

    const result = holdBackBoardChanges(shown, latest, NOTHING);

    expect(listIds(result.board.cards)).toEqual(["a"]);
    expect(result.held).toEqual([{ kind: "arrival", cardId: "new", key: "arrival:new" }]);
  });

  it("shows the Task that arrived once its arrival is released", () => {
    const shown = buildBoard(buildCard("a"));
    const latest = buildBoard(buildCard("a"), buildCard("new"));

    const result = holdBackBoardChanges(shown, latest, new Set([buildArrivalKey("new")]));

    expect(listIds(result.board.cards)).toEqual(["a", "new"]);
    expect(result.held).toEqual([]);
  });

  it("keeps the failing card as it was shown, in its place, until the failure is released", () => {
    const shown = buildBoard(buildCard("a"), buildCard("b"));
    const latest = buildBoard(buildCard("a"), buildCard("b", { failure: FAILURE }));

    const result = holdBackBoardChanges(shown, latest, NOTHING);

    expect(result.board.cards[1]!.failure).toBeUndefined();
    expect(result.held).toEqual([{ kind: "failure", cardId: "b", key: "failure:run-1" }]);

    const released = holdBackBoardChanges(shown, latest, new Set(["failure:run-1"]));
    expect(released.board.cards[1]!.failure).toEqual(FAILURE);
    expect(released.held).toEqual([]);
  });

  it("holds a second failure of the same Task even after the first was released", () => {
    const shown = buildBoard(buildCard("b"));
    const latest = buildBoard(buildCard("b", { failure: { ...FAILURE, runId: "run-2" } }));

    const result = holdBackBoardChanges(shown, latest, new Set(["failure:run-1"]));

    expect(result.held.map((change) => change.key)).toEqual(["failure:run-2"]);
  });

  it("shows other changes at once while it holds a failure back", () => {
    const shown = buildBoard(buildCard("a"), buildCard("b"));
    const latest = buildBoard(
      buildCard("a", { stage: "building" }),
      buildCard("b", { failure: FAILURE }),
    );

    const result = holdBackBoardChanges(shown, latest, NOTHING);

    expect(result.board.cards[0]!.stage).toBe("building");
    expect(result.board.cards[1]!.failure).toBeUndefined();
  });

  it("does not hold a failure the board already showed, or a Task that left", () => {
    const shown = buildBoard(buildCard("a", { failure: FAILURE }), buildCard("gone"));
    const latest = buildBoard(buildCard("a", { failure: FAILURE }));

    const result = holdBackBoardChanges(shown, latest, NOTHING);

    expect(listIds(result.board.cards)).toEqual(["a"]);
    expect(result.held).toEqual([]);
  });
});
