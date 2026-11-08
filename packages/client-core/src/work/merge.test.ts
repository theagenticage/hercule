/** Tests the words of a merge and the board change that shows a held merge as done. */
import { describe, expect, it } from "vitest";
import { buildCard } from "./cards.testing";
import {
  decideMerge,
  describeMerge,
  describeMergeFailure,
  describeMergeKeeps,
  describeMergeNote,
  describeMergedInto,
  describeMergedWithoutCheck,
  describeMergeRefused,
  describeMergeTarget,
  hideHeldMergeSources,
  readMergeCheck,
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
    expect(describeMergeTarget(title, { kind: "allowed" })).toBe(label);
  });

  it("promises nothing while the check runs, and is the same when the check could not be made", () => {
    expect(describeMergeTarget("Serve smaller", { kind: "checking" })).toBe(
      "Checking merge into Serve smaller",
    );
    expect(describeMergeTarget("Serve smaller", { kind: "unchecked" })).toBe(
      "Merge into Serve smaller",
    );
  });

  it("gives the refusal in its place, without its closing full stop, cut to fit", () => {
    expect(
      describeMergeTarget("Serve smaller", {
        kind: "refused",
        refusal: "Plan the launch already waits on this Task.",
      }),
    ).toBe("Cannot merge: Plan the launch already waits on this Task");
    const label = describeMergeTarget("Serve smaller", {
      kind: "refused",
      refusal: "x".repeat(80),
    });
    expect(label).toHaveLength(56);
    expect(label.endsWith("…")).toBe(true);
  });
});

describe("the note on the bottom edge of the card to merge into", () => {
  const keeps = "Keeps its title, stage and place";
  it.each([
    ["allowed", { kind: "allowed" }, keeps],
    ["checking", { kind: "checking" }, undefined],
    ["unchecked", { kind: "unchecked" }, "Could not check this merge first"],
    ["refused", { kind: "refused", refusal: "No." }, "Nothing will be merged"],
  ] as const)("is right for a check that is %s", (_name, check, note) => {
    expect(describeMergeNote(check, keeps)).toBe(note);
  });
});

describe("reading the answer of the merge check", () => {
  it("is allowed with no refusal and refused with one", () => {
    expect(readMergeCheck({})).toEqual({ kind: "allowed" });
    expect(readMergeCheck({ refusal: "Loop." })).toEqual({ kind: "refused", refusal: "Loop." });
  });
});

describe("what stays when two cards merge", () => {
  const initiatives = [
    { id: "checkout", name: "Checkout" },
    { id: "billing", name: "Billing and a very long name indeed" },
  ];
  const BASE = "Keeps its title, stage and place";
  it.each([
    ["neither card is in an initiative", {}, {}, BASE],
    [
      "both cards are in the same initiative",
      { initiativeId: "checkout" },
      { initiativeId: "checkout" },
      BASE,
    ],
    ["only the card merged into is in one", { initiativeId: "checkout" }, {}, BASE],
    [
      "the two are in different initiatives: the card merged into keeps its own",
      { initiativeId: "checkout" },
      { initiativeId: "billing" },
      "Keeps its title, stage, place and initiative Checkout",
    ],
    [
      "the card merged into has none: it takes the other card's",
      {},
      { initiativeId: "checkout" },
      "Keeps its title, stage and place, and takes the initiative Checkout",
    ],
    [
      "the name of the initiative taken is long",
      {},
      { initiativeId: "billing" },
      "Keeps its title, stage and place, and takes the initiative Billing and a very lo…",
    ],
    [
      "the card merged into is in an initiative that is not listed (closed)",
      { initiativeId: "closed" },
      { initiativeId: "billing" },
      "Keeps its title, stage, place and initiative",
    ],
    [
      "the card merged away is in a closed initiative and the other has none",
      {},
      { initiativeId: "closed" },
      "Keeps its title, stage and place, and takes the other card's initiative",
    ],
  ])("says it when %s", (_name, into, away, words) => {
    expect(describeMergeKeeps(into, away, initiatives)).toBe(words);
  });
});

describe("the decision for a merge once its check is known", () => {
  it("accepts what the check allowed", () => {
    expect(decideMerge({ kind: "allowed" }, "Refund emails")).toEqual({ kind: "accepted" });
  });

  it("refuses with the words for the undo line", () => {
    expect(
      decideMerge(
        { kind: "refused", refusal: "Plan already waits on this Task." },
        "Refund emails",
      ),
    ).toEqual({
      kind: "refused",
      words: '"Refund emails" was not merged: Plan already waits on this Task.',
    });
  });

  it("leaves a check that could not be made unchecked, never accepted", () => {
    expect(decideMerge({ kind: "unchecked" }, "Refund emails")).toEqual({ kind: "unchecked" });
  });
});

describe("the words after a merge", () => {
  it("says a merge was not sent because the controller would refuse it", () => {
    expect(describeMergeRefused("Refund emails", "Plan already waits on this Task.")).toBe(
      '"Refund emails" was not merged: Plan already waits on this Task.',
    );
  });

  it("names the Task merged into, quoted", () => {
    expect(describeMergedInto("Refund emails")).toBe('Merged into "Refund emails".');
  });

  it("says on the undo line that a merge went ahead without being checked", () => {
    expect(describeMergedWithoutCheck("Refund emails")).toBe(
      'Merged into "Refund emails". It could not be checked first.',
    );
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
