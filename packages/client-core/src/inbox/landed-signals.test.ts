/** Tests which cards a signal landed on between two reads of one visit, and how the visit holds them for the landing. */
import { describe, expect, it } from "vitest";
import { buildInbox, buildInboxCard, buildRequestCard, buildSignalLine } from "./cards.testing";
import {
  describeLanding,
  listLandedCards,
  listShownFreshIds,
  NO_LANDINGS,
  reachLandedCard,
  recordLandedSignals,
  releaseLandedCards,
  showHeldCards,
  type LandingHold,
} from "./landed-signals";

const withLatest = (id: string, signalId: string | undefined, createdAt?: string) =>
  buildInboxCard(id, {
    signals: {
      openCount: signalId === undefined ? 0 : 1,
      kinds: [],
      ...(signalId === undefined
        ? {}
        : {
            latest: buildSignalLine(signalId, "Tessa commented", {
              ...(createdAt === undefined ? {} : { createdAt }),
            }),
          }),
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
    [
      "a signal raised later replacing the latest, whatever its id",
      withLatest("1", "s9", "2026-11-07T09:00:00.000Z"),
      withLatest("1", "s1", "2026-11-07T09:05:00.000Z"),
      ["1"],
    ],
    [
      "an older signal becoming the latest after the newest was answered",
      withLatest("1", "s2", "2026-11-07T09:05:00.000Z"),
      withLatest("1", "s1", "2026-11-07T09:00:00.000Z"),
      [],
    ],
    [
      "an older signal with a smaller id becoming the latest in the same moment",
      withLatest("1", "s2"),
      withLatest("1", "s1"),
      [],
    ],
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
        signals: { openCount: 1, kinds: [], latest: buildSignalLine("s9", "Ines asked") },
      }),
      withLatest("1", "s1"),
    ]);
    expect(listLandedCards(before, after)).toEqual(["2", "1"]);
  });
});

describe("the landings of a visit", () => {
  const older = withLatest("1", "s1");
  const newer = withLatest("1", "s2");
  const untouched = withLatest("2", "s3");
  const before = buildInbox([older, untouched]);
  const after = buildInbox([newer, untouched]);
  const notReduced = () => false;
  const afterFirstRead = recordLandedSignals(NO_LANDINGS, before, notReduced);

  it("lands nothing on the first read, and remembers it", () => {
    expect(afterFirstRead).toEqual({ ...NO_LANDINGS, lastRead: before });
    expect(recordLandedSignals(afterFirstRead, before, notReduced)).toBe(afterFirstRead);
  });

  it("holds a landed card as it was, shows everything else as read, and keeps the order", () => {
    const landed = recordLandedSignals(afterFirstRead, after, notReduced);
    expect(landed.landing).toEqual({
      number: 1,
      isReduced: false,
      cards: [{ id: "1", tone: "plain" }],
    });
    const shown = showHeldCards(after, landed.holds);
    expect(shown.cards).toEqual([older, untouched]);
    expect(shown.cards[1]).toBe(untouched);
    expect(showHeldCards(after, NO_LANDINGS.holds)).toBe(after);
    expect([...landed.freshIds]).toEqual(["1"]);
    expect(listShownFreshIds(landed).size).toBe(0);
    expect(landed.announcement).toBe("");
  });

  it("lets a card go when its landing is released, and leaves the cards of another landing held", () => {
    const first = recordLandedSignals(afterFirstRead, after, notReduced);
    const secondRead = buildInbox([newer, withLatest("2", "s4")]);
    const both = recordLandedSignals(first, secondRead, notReduced);
    expect([...both.holds.keys()]).toEqual(["1", "2"]);
    const released = releaseLandedCards(both, 1);
    // Card 1 lies in the first landing only if the second did not take it over: it did not land again.
    expect(released.released).toEqual(["1"]);
    expect([...released.landings.holds.keys()]).toEqual(["2"]);
    expect(releaseLandedCards(both, 3)).toEqual({ landings: both, released: [] });
  });

  it("keeps the version a card was first held with when a second signal lands on it, and passes it to the second landing", () => {
    const first = recordLandedSignals(afterFirstRead, after, notReduced);
    const again = recordLandedSignals(
      first,
      buildInbox([withLatest("1", "s5"), untouched]),
      notReduced,
    );
    expect(again.holds.get("1")).toEqual<LandingHold>({ card: older, landing: 2 });
    expect(releaseLandedCards(again, 1)).toEqual({ landings: again, released: [] });
  });

  it("holds nothing and announces at once under Reduce motion", () => {
    const landed = recordLandedSignals(afterFirstRead, after, () => true);
    expect(landed.holds.size).toBe(0);
    expect(landed.landing?.isReduced).toBe(true);
    expect([...listShownFreshIds(landed)]).toEqual(["1"]);
    expect(landed.announcement).toBe("Ticket ACME-1: Tessa commented");
  });

  it("asks about Reduce motion only when a signal lands", () => {
    let asked = 0;
    const ask = () => {
      asked += 1;
      return false;
    };
    const quiet = recordLandedSignals(afterFirstRead, buildInbox([older, untouched]), ask);
    expect(quiet.landing).toBeUndefined();
    expect(asked).toBe(0);
    recordLandedSignals(afterFirstRead, after, ask);
    expect(asked).toBe(1);
  });

  it("announces the released cards by the newest read, and clears a card the user reached", () => {
    const landed = recordLandedSignals(afterFirstRead, after, notReduced);
    const { landings, released } = releaseLandedCards(landed, 1);
    expect(released).toEqual(["1"]);
    expect(landings.announcement).toBe("Ticket ACME-1: Tessa commented");
    expect([...listShownFreshIds(landings)]).toEqual(["1"]);
    expect(reachLandedCard(landings, "9")).toBe(landings);
    expect(reachLandedCard(landings, "1").freshIds.size).toBe(0);
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
        kinds: [],
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
        kinds: [],
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
