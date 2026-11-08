/** Tests the beads of an Initiative row: their kinds, their order in a cell, tally marks and the rings of Done Tasks. */
import { describe, expect, it } from "vitest";
import type { BoardStage, WorkCard } from "@hercule/contract";
import { buildCard, FAILURE, QUESTION } from "./cards.testing";
import { buildInitiativeLine, MOST_BEADS_BEFORE_TALLY, MOST_TALLY_MARKS } from "./initiative-line";
import { buildLane } from "./lanes";

/** Returns the line of a row holding `cards` and `doneRingCount` rings. */
const lineOf = (cards: readonly WorkCard[], doneRingCount = 0) =>
  buildInitiativeLine(buildLane("row", "Platform", null, cards).cells, doneRingCount);

const beadsAt = (line: ReturnType<typeof lineOf>, stage: BoardStage) =>
  line.cells.find((cell) => cell.stage === stage)!.beads;

describe("buildInitiativeLine", () => {
  it("has a cell for every stage and no reach when there is no bead", () => {
    const line = lineOf([]);
    expect(line.cells.map((cell) => cell.stage)).toEqual([
      "exploring",
      "planned",
      "building",
      "in-review",
      "landed",
    ]);
    expect(line.reachStageIndex).toBeNull();
  });

  it.each([
    ["an open card", buildCard("x", { stage: "building" }), "open"],
    ["a card at Landed", buildCard("x", { stage: "landed" }), "landed"],
    [
      "a blocked card",
      buildCard("x", {
        blockedBy: [{ id: "b", title: "B", stage: "building" }],
        blockedByCount: 1,
      }),
      "blocked",
    ],
    ["a card with a question", buildCard("x", { openQuestion: QUESTION }), "question"],
    ["a failed card", buildCard("x", { failure: FAILURE }), "failed"],
  ])("draws %s as a bead of its kind, with its Task", (_, card, kind) => {
    expect(beadsAt(lineOf([card]), card.stage)).toEqual([{ taskId: "x", kind }]);
  });

  it("orders a cell failed, question, open, blocked, landed, and keeps board order inside a kind", () => {
    const blocked = {
      blockedBy: [{ id: "b", title: "B", stage: "building" as const }],
      blockedByCount: 1,
    };
    const line = lineOf([
      buildCard("open1"),
      buildCard("blocked", blocked),
      buildCard("question", { openQuestion: QUESTION }),
      buildCard("open2"),
      buildCard("failed", { failure: FAILURE }),
    ]);
    expect(beadsAt(line, "exploring").map((bead) => bead.taskId)).toEqual([
      "failed",
      "question",
      "open1",
      "open2",
      "blocked",
    ]);
  });

  it("reaches the last stage that has a bead", () => {
    expect(lineOf([buildCard("a"), buildCard("b", { stage: "building" })]).reachStageIndex).toBe(2);
  });

  describe("tally marks", () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) => buildCard(`t${String(index)}`));

    it.each([
      [MOST_BEADS_BEFORE_TALLY, false],
      [MOST_BEADS_BEFORE_TALLY + 1, true],
    ])("a cell of %i beads is tally: %s", (count, isTally) => {
      expect(lineOf(many(count)).cells[0]?.isTally).toBe(isTally);
    });

    it("draws at most MOST_TALLY_MARKS marks, and counts every Task", () => {
      const line = lineOf(many(MOST_TALLY_MARKS + 7));
      expect(line.cells[0]?.beads).toHaveLength(MOST_TALLY_MARKS);
      expect(line.cells[0]?.beadCount).toBe(MOST_TALLY_MARKS + 7);
    });

    it("keeps the failed bead first in a tally cell, whatever its place on the board", () => {
      const line = lineOf([...many(12), buildCard("broke", { failure: FAILURE })]);
      const [first] = beadsAt(line, "exploring");
      expect(line.cells[0]?.isTally).toBe(true);
      expect(first).toEqual({ taskId: "broke", kind: "failed" });
    });

    it("keeps the failed bead when the cap cuts a cell", () => {
      const line = lineOf([
        ...many(MOST_TALLY_MARKS + 5),
        buildCard("broke", { failure: FAILURE }),
      ]);
      expect(beadsAt(line, "exploring")[0]).toEqual({ taskId: "broke", kind: "failed" });
      expect(beadsAt(line, "exploring")).toHaveLength(MOST_TALLY_MARKS);
    });
  });

  describe("rings of Done Tasks", () => {
    it("ends the Landed cell with a ring for each Done Task, after the landed cards", () => {
      const line = lineOf([buildCard("landed", { stage: "landed" })], 2);
      expect(beadsAt(line, "landed")).toEqual([
        { taskId: "landed", kind: "landed" },
        { taskId: null, kind: "landed" },
        { taskId: null, kind: "landed" },
      ]);
      expect(line.reachStageIndex).toBe(4);
    });

    it("draws rings with no card at all, and reaches Landed", () => {
      const line = lineOf([], 1);
      expect(beadsAt(line, "landed")).toEqual([{ taskId: null, kind: "landed" }]);
      expect(line.reachStageIndex).toBe(4);
    });

    it("keeps a failed card at Landed ahead of the rings, and makes a tally of many rings", () => {
      const line = lineOf([buildCard("broke", { stage: "landed", failure: FAILURE })], 11);
      expect(beadsAt(line, "landed")[0]).toEqual({ taskId: "broke", kind: "failed" });
      expect(line.cells[4]?.isTally).toBe(true);
    });

    it("draws no ring in another stage", () => {
      expect(beadsAt(lineOf([], 3), "building")).toEqual([]);
    });
  });
});
