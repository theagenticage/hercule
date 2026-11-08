/** Tests the offers of a card, what a click on one ends, the card once handed, and the line after an undo. */
import type { HandOffUndo } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { describeCardAloud } from "./card-aloud";
import { decideCardFace } from "./card-face";
import {
  decideHandedFace,
  describeHandMove,
  describeHandOffEnds,
  describeHandOffUndo,
  isHandOffTakenBack,
  listCardOffers,
  NO_OFFERS,
  partitionOffers,
} from "./card-hand-off";
import { buildInboxCard, buildWorkflowOffer } from "./cards.testing";

const review = buildWorkflowOffer("Review PR", ["github/review-requested"]);
const fix = buildWorkflowOffer("Fix bug", ["github/checks-failed"]);
const sameRepoOnly = buildWorkflowOffer("Ship it", [], {
  reason: "repository",
  message: "Ship it works on acme/web only",
});

describe("listCardOffers", () => {
  it("reads the set the card names and splits it, keeping the order", () => {
    const card = buildInboxCard("1", { offerSetId: "set-a" });
    expect(listCardOffers(card, { "set-a": [review, sameRepoOnly, fix] })).toEqual({
      available: [review, fix],
      unavailable: [sameRepoOnly],
    });
  });

  it("gives a card whose set is missing no offers", () => {
    expect(listCardOffers(buildInboxCard("1", { offerSetId: "gone" }), {})).toEqual(NO_OFFERS);
  });
});

describe("describeHandMove", () => {
  it.each([
    ["no offer", NO_OFFERS, { kind: "none" }],
    ["only offers that cannot take it", partitionOffers([sameRepoOnly]), { kind: "none" }],
    ["one offer", partitionOffers([review]), { kind: "one", offer: review }],
    [
      "one that fits and one that does not",
      partitionOffers([review, sameRepoOnly]),
      { kind: "one", offer: review },
    ],
    ["several", partitionOffers([review, fix]), { kind: "several" }],
  ])("%s", (_name, offers, move) => {
    expect(describeHandMove(offers)).toEqual(move);
  });
});

describe("describeHandOffEnds", () => {
  const answers = ["github/review-requested", "github/team-review-requested"];
  it.each([
    [
      "ends one kind and leaves another",
      ["github/review-requested", "github/mentioned"],
      "Ends Review requested. Mentioned stays open.",
    ],
    [
      "ends every kind it answers that is open",
      answers,
      "Ends Review requested and Team review requested.",
    ],
    [
      "lists each kind once",
      ["github/review-requested", "github/review-requested"],
      "Ends Review requested.",
    ],
    [
      "ends nothing on a card that holds nothing it answers",
      ["github/mentioned", "github/checks-failed"],
      "Ends nothing. Mentioned and Checks failed stay open.",
    ],
    ["ends nothing on a card with no open signal", [], "Ends nothing."],
  ])("%s", (_name, openKinds, line) => {
    expect(describeHandOffEnds({ answers }, openKinds)).toBe(line);
  });
});

describe("decideHandedFace", () => {
  it("says the workflow has it, and a screen reader reads that where the wait was", () => {
    const card = buildInboxCard("1", { title: "Fix the basket" });
    const face = decideHandedFace(decideCardFace(card), { workflowId: "wf", name: "Agent review" });
    expect(face.sentence).toEqual({ text: "Agent review has it", tone: "plain" });
    expect(describeCardAloud(face, null, 0)).toBe(
      "Ticket, ACME-1, Fix the basket, Agent review has it",
    );
  });
});

describe("describeHandOffUndo", () => {
  const base: HandOffUndo = {
    outcome: "undone",
    stopRequested: true,
    taskRemoved: false,
    stageRestored: false,
    failureRestored: false,
  };
  it.each([
    ["undone", base, [], "Took back Review PR. Nothing had started."],
    [
      "undone, with a signal it ended",
      base,
      ["github/review-requested"],
      "Took back Review PR. Nothing had started. Review requested stays ended.",
    ],
    [
      "undone, with a failure brought back",
      { ...base, failureRestored: true },
      [],
      "Took back Review PR. Nothing had started. The earlier failure is back.",
    ],
    [
      "stopped, with a reason",
      { ...base, outcome: "stopped" as const, reason: "A thread joined the Task" },
      [],
      "Asked Review PR to stop. Anything it already did stays. A thread joined the Task.",
    ],
    [
      "stopped, with two signals it ended",
      { ...base, outcome: "stopped" as const },
      ["github/review-requested", "github/mentioned"],
      "Asked Review PR to stop. Anything it already did stays. Review requested and Mentioned stay ended.",
    ],
    ["too late", { ...base, outcome: "too-late" as const }, [], "Review PR already finished."],
  ])("%s", (_name, undo, endedKinds, line) => {
    expect(describeHandOffUndo(undo, "Review PR", endedKinds)).toBe(line);
  });

  it("plays the card backwards only when the hand-off was taken back", () => {
    expect(isHandOffTakenBack(base)).toBe(true);
    expect(isHandOffTakenBack({ ...base, outcome: "stopped" })).toBe(false);
    expect(isHandOffTakenBack({ ...base, outcome: "too-late" })).toBe(false);
  });
});
