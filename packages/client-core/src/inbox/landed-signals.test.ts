/** Tests which cards a signal landed on between two reads of one visit, and how the page holds them for the landing. */
import { describe, expect, it } from "vitest";
import { buildInbox, buildInboxCard, buildRequestCard, buildSignalLine } from "./cards.testing";
import {
  describeLanding,
  holdLandedCards,
  listLandedCards,
  releaseHeldCards,
  showHeldCards,
  type HeldCard,
} from "./landed-signals";

const withLatest = (id: string, signalId: string | undefined) =>
  buildInboxCard(id, {
    signals: {
      openCount: signalId === undefined ? 0 : 1,
      ...(signalId === undefined ? {} : { latest: buildSignalLine(signalId, "Tessa commented") }),
    },
  });

describe("listLandedCards", () => {
  it.each([
    [
      "a new signal on a card that had none",
      withLatest("1", undefined),
      withLatest("1", "s1"),
      ["1"],
    ],
    ["a newer signal replacing the latest", withLatest("1", "s1"), withLatest("1", "s2"), ["1"]],
    ["the same signal read again", withLatest("1", "s1"), withLatest("1", "s1"), []],
    ["a signal that ended and left none", withLatest("1", "s1"), withLatest("1", undefined), []],
  ])("lists %s", (_name, before, after, landed) => {
    expect(listLandedCards(buildInbox([before]), buildInbox([after]))).toEqual(landed);
  });

  it("leaves out a card that is new to the page and one that has left", () => {
    const before = buildInbox([withLatest("1", "s1"), withLatest("2", "s2")]);
    const after = buildInbox([withLatest("2", "s2"), withLatest("3", "s3")]);
    expect(listLandedCards(before, after)).toEqual([]);
  });

  it("lists the cards in the order of the later read", () => {
    const before = buildInbox([withLatest("1", undefined), buildRequestCard("2")]);
    const after = buildInbox([
      buildRequestCard("2", {
        signals: { openCount: 1, latest: buildSignalLine("s9", "Ines asked") },
      }),
      withLatest("1", "s1"),
    ]);
    expect(listLandedCards(before, after)).toEqual(["2", "1"]);
  });
});

describe("holding the landed cards for their landing", () => {
  const older = withLatest("1", "s1");
  const newer = withLatest("1", "s2");
  const untouched = withLatest("2", "s3");
  const before = buildInbox([older, untouched]);
  const after = buildInbox([newer, untouched]);

  it("shows a held card as it was and everything else as read, in the same order", () => {
    const held = holdLandedCards(new Map(), before, ["1"], 1);
    const shown = showHeldCards(after, held);
    expect(shown.cards).toEqual([older, untouched]);
    expect(shown.cards[1]).toBe(untouched);
  });

  it("returns the read itself when nothing is held", () => {
    expect(showHeldCards(after, new Map())).toBe(after);
  });

  it("lets a card go when its landing is released, and leaves the cards of another landing held", () => {
    const first = holdLandedCards(new Map(), before, ["1"], 1);
    const both = holdLandedCards(first, before, ["2"], 2);
    expect([...releaseHeldCards(both, 1).keys()]).toEqual(["2"]);
    expect(releaseHeldCards(both, 3)).toBe(both);
  });

  it("keeps the version a card was first held with when a second signal lands on it, and passes it to the second landing", () => {
    const first = holdLandedCards(new Map(), before, ["1"], 1);
    const again = holdLandedCards(first, after, ["1"], 2);
    expect(again.get("1")).toEqual<HeldCard>({ card: older, landing: 2 });
    expect(releaseHeldCards(again, 1)).toBe(again);
  });

  it("holds nothing for a card the earlier read did not have", () => {
    const held = holdLandedCards(new Map(), before, ["9"], 1);
    expect(held.size).toBe(0);
  });
});

describe("describeLanding", () => {
  it("names the card and says its sentence, in the tone of the signal", () => {
    const card = buildInboxCard("1", {
      noun: "Ticket",
      identifier: "OPS-7",
      yours: true,
      signals: {
        openCount: 1,
        latest: buildSignalLine("s1", "Checks failed", {
          say: { say: "Checks failed", tone: "bad" },
        }),
      },
    });
    expect(describeLanding(card)).toEqual({
      tone: "bad",
      announcement: "Ticket OPS-7: Checks failed",
    });
  });

  it("words a card that rides on another by what it asks, and keeps a plain tone on someone else's", () => {
    const card = buildRequestCard("2", {
      noun: "Pull request",
      identifier: "#12",
      ridesOn: "acme:ticket:7",
      yours: false,
      person: { name: "Ines" },
      signals: {
        openCount: 1,
        latest: buildSignalLine("s2", "Omar commented", {
          say: { say: "Omar commented", tone: "bad" },
        }),
      },
    });
    expect(describeLanding(card)).toEqual({
      tone: "plain",
      announcement: "Pull request #12: Omar commented",
    });
  });

  it("announces a card with no sentence by its name alone", () => {
    const card = buildInboxCard("3", { noun: "Ticket", identifier: "OPS-9" });
    expect(describeLanding(card)).toEqual({ tone: "plain", announcement: "Ticket OPS-9" });
  });
});
