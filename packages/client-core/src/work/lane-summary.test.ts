/** Tests what a lane's head says: the counts of a folded lane, the dots, and the failed count. */
import { describe, expect, it } from "vitest";
import { buildBoard, buildCard, FAILURE, QUESTION } from "./cards.testing";
import { summarizeLane } from "./lane-summary";
import { buildLanes } from "./lanes";

const [LANE] = buildLanes(
  buildBoard(
    buildCard("a", { projectId: "depots" }),
    buildCard("b", { projectId: "depots", openQuestion: QUESTION }),
    buildCard("c", { projectId: "depots", stage: "building" }),
    buildCard("d", { projectId: "depots", stage: "landed", failure: FAILURE }),
    buildCard("e", { projectId: "depots", stage: "landed", failure: FAILURE }),
  ),
  [{ id: "depots", name: "Depot returns" }],
);

describe("summarizeLane", () => {
  it("counts the cards of each stage, with a dot where a card has a question or a failure", () => {
    expect(summarizeLane(LANE!).stageCounts).toEqual([
      { stage: "exploring", count: 2, showsDot: true },
      { stage: "planned", count: 0, showsDot: false },
      { stage: "building", count: 1, showsDot: false },
      { stage: "in-review", count: 0, showsDot: false },
      { stage: "landed", count: 2, showsDot: true },
    ]);
  });

  it("counts the failed cards of the lane, also in Landed", () => {
    expect(summarizeLane(LANE!).failedCount).toBe(2);
  });

  it("counts no failure for a question", () => {
    const [lane] = buildLanes(buildBoard(buildCard("a", { openQuestion: QUESTION })), []);
    expect(summarizeLane(lane!).failedCount).toBe(0);
  });
});
