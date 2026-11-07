import { describe, expect, it } from "vitest";
import { buildCard } from "./cards.testing";
import { countCardsByStage } from "./stage-counts";

describe("countCardsByStage", () => {
  it("counts the cards of each stage, and 0 for a stage with none", () => {
    expect(
      countCardsByStage([buildCard("a"), buildCard("b"), buildCard("c", { stage: "in-review" })]),
    ).toEqual({ exploring: 2, planned: 0, building: 0, "in-review": 1, landed: 0 });
  });
});
