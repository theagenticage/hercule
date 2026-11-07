/** Tests the words of a merge and the board change that shows a held merge as done. */
import { describe, expect, it } from "vitest";
import { buildCard } from "./cards.testing";
import {
  describeMerge,
  describeMergeFailure,
  describeMergedInto,
  describeMergeTarget,
  hideHeldMergeSources,
} from "./merge";

describe("the label of the card to merge into", () => {
  it.each([
    ["a short title", "Serve smaller", "Merge into Serve smaller"],
    [
      "a title of exactly 22 characters",
      "1234567890123456789012",
      "Merge into 1234567890123456789012",
    ],
    [
      "a long title, cut with an ellipsis",
      "Serve smaller checkout pages",
      "Merge into Serve smaller checkou…",
    ],
    [
      "a cut that would end on a space",
      "Serve smaller things now please",
      "Merge into Serve smaller things…",
    ],
  ])("shows %s", (_name, title, label) => {
    expect(describeMergeTarget(title)).toBe(label);
  });
});

describe("the words after a merge", () => {
  it("names the Task merged into, quoted", () => {
    expect(describeMergedInto("Refund emails")).toBe('Merged into "Refund emails".');
  });

  it("cuts a long title of the Task merged into", () => {
    expect(describeMergedInto("x".repeat(40))).toBe(`Merged into "${"x".repeat(31)}…".`);
  });

  it("quotes both titles for the undo stack, cutting a long one", () => {
    expect(describeMerge("Refund emails", "x".repeat(40))).toBe(
      `Merged "Refund emails" into "${"x".repeat(31)}…"`,
    );
  });

  it("says why a merge failed and that the card is back, ending in one full stop", () => {
    expect(
      describeMergeFailure(
        "Refund emails",
        "Those Tasks have 20 labels together. Remove some first.",
      ),
    ).toBe(
      'The merge did not happen, so "Refund emails" is back on the board: Those Tasks have 20 labels together. Remove some first.',
    );
    expect(describeMergeFailure("Refund emails", "The app closed before this was sent.")).toBe(
      'The merge did not happen, so "Refund emails" is back on the board: The app closed before this was sent.',
    );
  });
});

describe("a card whose merge is held", () => {
  const source = buildCard("t1");
  const target = buildCard("t2");
  const other = buildCard("t3");

  it("leaves the board without it, and every other card as it is", () => {
    const shown = hideHeldMergeSources([source, target, other], [{ taskId: "t1" }]);
    expect(shown).toEqual([target, other]);
    expect(shown[0]).toBe(target);
  });

  it("hides every held source", () => {
    expect(
      hideHeldMergeSources([source, target, other], [{ taskId: "t1" }, { taskId: "t3" }]),
    ).toEqual([target]);
  });

  it.each([
    ["nothing is held", []],
    ["the held Task is not on the board", [{ taskId: "gone" }]],
  ])("returns the same array when %s", (_name, held) => {
    const cards = [source, target];
    expect(hideHeldMergeSources(cards, held)).toBe(cards);
  });
});
