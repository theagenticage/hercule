/** Tests what a lane's head says: the failed count, and the dot under a stage of a folded lane. */
import { describe, expect, it } from "vitest";
import { buildBoard, buildCard, FAILURE, QUESTION } from "./cards.testing";
import { chooseCellDot, summarizeLane } from "./lane-summary";
import { buildLanes } from "./lanes";

describe("summarizeLane", () => {
  it("counts the failed cards of the lane, also in Landed", () => {
    const [lane] = buildLanes(
      buildBoard(
        buildCard("a", { projectId: "depots" }),
        buildCard("d", { projectId: "depots", stage: "landed", failure: FAILURE }),
        buildCard("e", { projectId: "depots", stage: "building", failure: FAILURE }),
      ),
      [{ id: "depots", name: "Depot returns" }],
    );
    expect(summarizeLane(lane!).failedCount).toBe(2);
  });

  it("counts no failure for a question", () => {
    const [lane] = buildLanes(buildBoard(buildCard("a", { openQuestion: QUESTION })), []);
    expect(summarizeLane(lane!).failedCount).toBe(0);
  });
});

describe("chooseCellDot", () => {
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
  ])("is the dot for %s", (_name, cards, expected) => {
    expect(chooseCellDot(cards)).toBe(expected);
  });
});
