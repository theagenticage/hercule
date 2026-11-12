/** Tests the offers of a card, what a click on one ends, the card once handed, and the line after an undo. */
import type { EntitySignalLine, HandOffUndo } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import {
  decideHandMove,
  decideHandOffFit,
  describeHandOffAsks,
  readHandOffAsks,
  describeHandOffEnds,
  describeHandOffUndo,
  findHandOffs,
  isHandOffTakenBack,
  listAvailableHandOffs,
  listCardOffers,
  NO_OFFERS,
  partitionOffers,
  rankHandOffs,
} from "./card-hand-off";
import { buildInboxAsk, buildInboxThing, buildWorkflowOffer } from "./cards.testing";

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

describe("decideHandOffFit and rankHandOffs", () => {
  const reviewKind = "acme/review-requested";
  const mentionKind = "acme/mention";
  const endsBoth = buildWorkflowOffer("Handle both", [reviewKind, mentionKind]);
  const endsReview = buildWorkflowOffer("Review PR", [reviewKind]);
  const endsNone = buildWorkflowOffer("Fix a failing check", ["acme/checks-failed"]);

  it.each([
    ["every open ask", endsBoth, "all"],
    ["some of the open asks", endsReview, "some"],
    ["none of the open asks", endsNone, "none"],
  ] as const)("a workflow that ends %s fits as %s", (_name, offer, fit) => {
    expect(decideHandOffFit(offer, [reviewKind, mentionKind])).toBe(fit);
  });

  it("fits every workflow equally on a thing with no asks", () => {
    expect(decideHandOffFit(endsNone, [])).toBe("all");
  });

  it("puts the workflows that end every ask first, then some, then none", () => {
    const ranked = rankHandOffs([endsNone, endsReview, endsBoth], [reviewKind, mentionKind]);
    expect(ranked.map((offer) => offer.name)).toEqual([
      "Handle both",
      "Review PR",
      "Fix a failing check",
    ]);
  });

  it("puts the most recently used first among equals, then by name, and never reorders its input", () => {
    const zed = buildWorkflowOffer("Zed", [reviewKind]);
    const alpha = buildWorkflowOffer("Alpha", [reviewKind]);
    const old = {
      ...buildWorkflowOffer("Old", [reviewKind]),
      lastHandedAt: "2026-11-01T00:00:00.000Z",
    };
    const recent = {
      ...buildWorkflowOffer("Recent", [reviewKind]),
      lastHandedAt: "2026-11-09T00:00:00.000Z",
    };
    const input = [zed, alpha, old, recent];

    expect(rankHandOffs(input, [reviewKind]).map((offer) => offer.name)).toEqual([
      "Recent",
      "Old",
      "Alpha",
      "Zed",
    ]);
    expect(input.map((offer) => offer.name)).toEqual(["Zed", "Alpha", "Old", "Recent"]);
  });

  it("lets fit outrank how recently a workflow was used", () => {
    const usedLast = { ...endsNone, lastHandedAt: "2026-11-09T00:00:00.000Z" };
    expect(rankHandOffs([usedLast, endsReview], [reviewKind]).map((offer) => offer.name)).toEqual([
      "Review PR",
      "Fix a failing check",
    ]);
  });
});

describe("describeHandOffAsks", () => {
  const reviewKind = "acme/review-requested";
  const mentionKind = "acme/mention";
  const mei = buildInboxAsk("a1", "Mei");
  const omar = buildInboxAsk("a2", "Omar", { kind: mentionKind, noun: "mention" });
  const thing = {
    asks: [mei, omar],
    askCount: 2,
    askKinds: [reviewKind, mentionKind],
    openKinds: [reviewKind, mentionKind],
  };
  const reviewers = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      buildInboxAsk(`r${String(index)}`, `P${String(index)}`),
    );

  it("names the ask it ends and the ask it leaves with the user", () => {
    expect(describeHandOffAsks({ answers: [reviewKind] }, thing)).toBe(
      "Ends Mei’s review request. Leaves Omar’s mention with you.",
    );
  });

  it("has no leaves part when it ends every ask", () => {
    expect(describeHandOffAsks({ answers: [reviewKind, mentionKind] }, thing)).toBe(
      "Ends Mei’s review request and Omar’s mention.",
    );
  });

  it("says it ends none of its asks, and names what stays", () => {
    expect(describeHandOffAsks({ answers: [] }, thing)).toBe(
      "Ends none of its asks. Leaves Mei’s review request and Omar’s mention with you.",
    );
  });

  it("names an ask no person raised by its noun, and a repeated ask once", () => {
    const system = buildInboxAsk("a3", null, {
      kind: "acme/checks-failed",
      noun: "failing checks",
    });
    expect(
      describeHandOffAsks(
        { answers: [reviewKind] },
        {
          ...thing,
          asks: [mei, buildInboxAsk("a4", "Mei"), system],
          askCount: 3,
          askKinds: [reviewKind, "acme/checks-failed"],
        },
      ),
    ).toBe("Ends Mei’s review request. Leaves the failing checks with you.");
  });

  it("counts the asks past the eight it lists on the side their kinds put them", () => {
    const many = {
      asks: reviewers(8),
      askCount: 11,
      askKinds: [reviewKind],
      openKinds: [reviewKind],
    };

    expect(describeHandOffAsks({ answers: [reviewKind] }, many)).toMatch(
      /^Ends P0’s review request, .*, P7’s review request and 3 more\.$/,
    );
    expect(describeHandOffAsks({ answers: [] }, many)).toMatch(
      /^Ends none of its asks\. Leaves P0’s review request, .*, P7’s review request and 3 more with you\.$/,
    );
  });

  it("says more asks are not named when the workflow ends only some of the kinds", () => {
    const line = describeHandOffAsks(
      { answers: [reviewKind] },
      {
        asks: reviewers(8),
        askCount: 10,
        askKinds: [reviewKind, mentionKind],
        openKinds: [reviewKind, mentionKind],
      },
    );
    expect(line.endsWith("2 more asks are not named.")).toBe(true);
  });

  it("falls back to the open kinds for a thing that asks nothing", () => {
    expect(
      describeHandOffAsks(
        { answers: [reviewKind] },
        { asks: [], askCount: 0, askKinds: [], openKinds: [reviewKind, "acme/fyi"] },
      ),
    ).toBe("Ends Review requested. Fyi stays open.");
  });
});

describe("listAvailableHandOffs and findHandOffs", () => {
  const reviewKind = "acme/review-requested";
  const thing = {
    asks: [buildInboxAsk("a1", "Mei")],
    askCount: 1,
    askKinds: [reviewKind],
    openKinds: [reviewKind],
  };
  const choices = listAvailableHandOffs(
    partitionOffers([
      buildWorkflowOffer("Split the pull request", []),
      buildWorkflowOffer("Security review", [reviewKind]),
      sameRepoOnly,
    ]),
    thing,
  );

  it("ranks the available workflows and writes each one's line", () => {
    expect(choices.map(({ offer, line }) => [offer.name, line])).toEqual([
      ["Security review", "Ends Mei’s review request."],
      ["Split the pull request", "Ends none of its asks. Leaves Mei’s review request with you."],
    ]);
  });

  it("finds a workflow by its name or by what it does, ignoring case", () => {
    expect(findHandOffs(choices, " SEC ").map(({ offer }) => offer.name)).toEqual([
      "Security review",
    ]);
    expect(findHandOffs(choices, "ends mei").map(({ offer }) => offer.name)).toEqual([
      "Security review",
    ]);
    // What a workflow leaves with the user is not what it does.
    expect(findHandOffs(choices, "leaves")).toEqual([]);
    expect(findHandOffs(choices, "")).toBe(choices);
    expect(findHandOffs(choices, "nothing like it")).toEqual([]);
  });

  it("does not split the English of a line: an asker named Leaves is still found", () => {
    const odd = listAvailableHandOffs(
      partitionOffers([buildWorkflowOffer("Security review", [reviewKind])]),
      { ...thing, asks: [buildInboxAsk("a1", "Leaves Smith")] },
    );
    expect(findHandOffs(odd, "smith").map(({ offer }) => offer.name)).toEqual(["Security review"]);
  });
});

describe("readHandOffAsks", () => {
  const reviewKind = "acme/review-requested";
  const mentionKind = "acme/mention";
  const signal = (id: string, kind: string, overrides: Partial<EntitySignalLine> = {}) => ({
    id,
    kind,
    title: "A title",
    priority: "normal" as const,
    status: "open" as const,
    createdAt: `2026-11-0${id}T09:00:00.000Z`,
    say: { say: "Someone asked", tone: "plain" as const },
    snoozed: false,
    ...overrides,
  });
  const row = {
    asks: [buildInboxAsk("a1", "Mei")],
    askCount: 5,
    askKinds: [reviewKind, mentionKind],
    openKinds: [reviewKind, mentionKind],
  };

  it("lists every open ask of the detail, newest first, and leaves out snoozed and resolved signals", () => {
    const { asks, askCount } = readHandOffAsks(row, [
      signal("1", reviewKind, { asker: "Mei" }),
      signal("2", mentionKind, { asker: "Omar" }),
      signal("3", reviewKind, { snoozed: true }),
      signal("4", reviewKind, { status: "resolved" }),
      signal("5", "acme/fyi"),
    ]);

    expect(asks.map((ask) => ask.id)).toEqual(["2", "1"]);
    expect(askCount).toBe(2);
  });

  it("takes the noun from a row ask of the same kind, else from the kind's key", () => {
    const { asks } = readHandOffAsks(row, [signal("1", reviewKind), signal("2", mentionKind)]);

    expect(asks.map((ask) => ask.noun)).toEqual(["mention", "review request"]);
  });
});
