/** Tests which cards a signal landed on between two reads of one visit. */
import { describe, expect, it } from "vitest";
import { buildInbox, buildInboxCard, buildRequestCard, buildSignalLine } from "./cards.testing";
import { listLandedCards } from "./landed-signals";

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
