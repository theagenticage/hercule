/** Tests the line a failed card shows and the name a screen reader reads for a card. */
import { describe, expect, it } from "vitest";
import { buildCard, FAILURE, QUESTION } from "./cards.testing";
import { describeCardForReader, describeCardFailure } from "./card-words";

describe("describeCardFailure", () => {
  it.each([
    ["with a cause", "the branch changed mid-run", "Review PR failed: the branch changed mid-run."],
    ["with no cause", "", "Review PR failed."],
    ["with a cause of only spaces", "  \n ", "Review PR failed."],
    [
      "with a cause that ends in a full stop",
      "Exited with code 1.",
      "Review PR failed: Exited with code 1.",
    ],
    ["with a cause of several lines", "first\n  second", "Review PR failed: first second."],
  ])("writes the line %s", (_, cause, expected) => {
    expect(describeCardFailure({ ...FAILURE, cause }).text).toBe(expected);
  });

  it("returns the workflow name apart, for a screen to style", () => {
    expect(describeCardFailure(FAILURE)).toMatchObject({
      workflowName: "Review PR",
      outcome: " failed: the branch changed mid-run.",
    });
  });
});

describe("describeCardForReader", () => {
  const NOW = new Date("2026-11-04T09:00:00.000Z");

  it("reads the title, the stage and the age for a plain card", () => {
    const card = buildCard("a", { title: "Add a refund button", stage: "in-review" });
    expect(describeCardForReader(card, NOW)).toBe("Add a refund button, In review, 3 days ago");
  });

  it("reads what broke before what it asks, and both before the stage", () => {
    const card = buildCard("a", {
      title: "Add a refund button",
      stage: "building",
      failure: FAILURE,
      openQuestion: QUESTION,
    });
    expect(describeCardForReader(card, NOW)).toBe(
      "Add a refund button, Review PR failed: the branch changed mid-run., Should refunds go back to the original card?, Building, 3 days ago",
    );
  });
});
