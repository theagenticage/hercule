/** Tests the progress of an Initiative: Done counts as landed, Dropped leaves, and the words under its name. */
import { describe, expect, it } from "vitest";
import { buildBoard, buildCard } from "./cards.testing";
import { computeInitiativeProgress, describeInitiativeFacts } from "./initiative-progress";

describe("computeInitiativeProgress", () => {
  const board = {
    ...buildBoard(
      buildCard("a", { initiativeId: "platform", stage: "landed" }),
      buildCard("b", { initiativeId: "platform", stage: "building" }),
      buildCard("c", { initiativeId: "platform", stage: "exploring" }),
      buildCard("other", { initiativeId: "launch", stage: "landed" }),
      buildCard("loose", { stage: "landed" }),
    ),
  };

  it.each([
    ["cards at Landed are landed and every card is in the total", {}, { landed: 1, total: 3 }],
    ["Done Tasks are landed and in the total", { platform: 2 }, { landed: 3, total: 5 }],
    ["another Initiative's Done Tasks are not counted", { launch: 4 }, { landed: 1, total: 3 }],
  ])("%s", (_, initiativeDoneCounts, progress) => {
    expect(computeInitiativeProgress({ ...board, initiativeDoneCounts }, "platform")).toEqual(
      progress,
    );
  });

  it("counts an Initiative with no Task as 0 of 0", () => {
    expect(computeInitiativeProgress(board, "empty")).toEqual({ landed: 0, total: 0 });
  });
});

describe("describeInitiativeFacts", () => {
  it.each([
    ["on top, with its Project", { landed: 2, total: 8 }, "Platform", "Platform · 2 of 8 landed"],
    ["in its Project's lane", { landed: 2, total: 8 }, undefined, "2 of 8 landed"],
    ["with no Task, on top", { landed: 0, total: 0 }, "Platform", "Platform"],
    ["with no Task, in a lane", { landed: 0, total: 0 }, undefined, null],
    ["with all Tasks landed", { landed: 3, total: 3 }, undefined, "3 of 3 landed"],
  ])("words an Initiative %s", (_, progress, projectName, words) => {
    expect(describeInitiativeFacts(progress, projectName)).toBe(words);
  });
});
