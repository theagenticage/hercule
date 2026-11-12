/** Tests the offers of a card, what a click on one ends, the card once handed, and the line after an undo. */
import type { HandOffUndo } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import {
  decideCardHolder,
  decideHandedSentence,
  decideHandMove,
  describeHandOffEnds,
  describeHandOffUndo,
  isHandOffTakenBack,
  listOpenSignalKinds,
  listCardOffers,
  NO_OFFERS,
  partitionOffers,
  readOpenCardHandOff,
} from "./card-hand-off";
import { buildInboxThing, buildSignalLine, buildWorkflowOffer } from "./cards.testing";

const review = buildWorkflowOffer("Review PR", ["github/review-requested"]);
const fix = buildWorkflowOffer("Fix bug", ["github/checks-failed"]);
const sameRepoOnly = buildWorkflowOffer("Ship it", [], {
  reason: "repository",
  message: "Ship it works on acme/web only",
});

describe("listCardOffers", () => {
  it("reads the set the card names and splits it, keeping the order", () => {
    const card = buildInboxThing("1", { offerSetId: "set-a" });
    expect(listCardOffers(card, { "set-a": [review, sameRepoOnly, fix] })).toEqual({
      available: [review, fix],
      unavailable: [sameRepoOnly],
    });
  });

  it("gives a card whose set is missing no offers", () => {
    expect(listCardOffers(buildInboxThing("1", { offerSetId: "gone" }), {})).toEqual(NO_OFFERS);
  });

  it("gives every card of one set the same offers, so a card draws again only when its own set changes", () => {
    const set = [review, fix];
    const first = listCardOffers(buildInboxThing("1", { offerSetId: "set-a" }), { "set-a": set });
    const second = listCardOffers(buildInboxThing("2", { offerSetId: "set-a" }), {
      "set-a": set,
      "set-b": [sameRepoOnly],
    });
    const changed = listCardOffers(buildInboxThing("2", { offerSetId: "set-a" }), {
      "set-a": [review],
    });
    expect(second).toBe(first);
    expect(changed).not.toBe(first);
  });
});

describe("decideHandMove", () => {
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
    expect(decideHandMove(offers)).toEqual(move);
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

describe("decideHandedSentence", () => {
  it("says the workflow has it, in a plain tone", () => {
    expect(decideHandedSentence({ workflowId: "wf", name: "Agent review" })).toEqual({
      text: "Agent review has it",
      tone: "plain",
    });
  });
});

describe("decideCardHolder", () => {
  const agent = { workflowId: "wf-agent-review", name: "Agent review" };
  const other = { workflowId: "wf-other", name: "Other" };

  it.each([
    ["no Task and no live workflow", {}, undefined],
    [
      "a Task and no live workflow, such as a card whose run ended",
      { taskId: "task-1" },
      { kind: "you" },
    ],
    [
      "a live workflow before the Task is known",
      { liveWorkflows: [agent] },
      { kind: "colleague", workflow: agent },
    ],
    [
      "several live workflows, the newest run first",
      { taskId: "task-1", liveWorkflows: [agent, other] },
      { kind: "colleague", workflow: agent },
    ],
  ])("holds a card with %s", (_name, overrides, holder) => {
    expect(decideCardHolder(buildInboxThing("1", overrides))).toEqual(holder);
  });
});

describe("readOpenCardHandOff", () => {
  const bot = { id: "conn-bot", label: "northwind-bot" };
  const ava = { id: "conn-ava", label: "ava-northwind" };
  const listed = buildInboxThing("1", {
    offerSetId: "set-a",
    actingConnections: [bot],
    openKinds: ["github/mentioned"],
  });
  const inbox = { offerSets: { "set-a": [review, sameRepoOnly] } };
  const detail = {
    kindAvailable: true,
    offers: [fix],
    actingConnections: [ava],
    signals: [buildSignalLine("s1", "Asked", { kind: "github/review-requested" })],
  };

  it("reads the Inbox's own sets and the card as listed until the read has answered", () => {
    expect(readOpenCardHandOff(undefined, listed, inbox)).toEqual({
      offers: { available: [review], unavailable: [sameRepoOnly] },
      actingConnections: [bot],
      openKinds: ["github/mentioned"],
    });
  });

  it("reads the card's own answer once it has one", () => {
    expect(readOpenCardHandOff(detail, listed, inbox)).toEqual({
      offers: { available: [fix], unavailable: [] },
      actingConnections: [ava],
      openKinds: ["github/review-requested"],
    });
  });

  it.each([
    ["the kind is not available", { ...detail, kindAvailable: false }, listed, inbox],
    ["the Inbox has not answered", detail, listed, undefined],
    ["the card is not listed and has no read", undefined, undefined, inbox],
  ])("has no offers when %s", (_name, forDetail, forListed, forInbox) => {
    expect(readOpenCardHandOff(forDetail, forListed, forInbox).offers).toEqual(NO_OFFERS);
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

describe("listOpenSignalKinds", () => {
  it("lists each kind that has an open line once, and none that only has resolved lines", () => {
    expect(
      listOpenSignalKinds([
        { kind: "github/review-requested", status: "open" },
        { kind: "github/mention", status: "resolved" },
        { kind: "github/review-requested", status: "open" },
        { kind: "github/checks-failed", status: "open" },
      ]),
    ).toEqual(["github/review-requested", "github/checks-failed"]);
  });
});
