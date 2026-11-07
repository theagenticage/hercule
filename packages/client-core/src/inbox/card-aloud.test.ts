/** Tests the words a screen reader says for a card. */
import { describe, expect, it } from "vitest";
import { describeCardAloud } from "./card-aloud";
import { decideCardFace } from "./card-face";
import { describeCardWait } from "./card-wait";
import { buildInboxCard, buildRequestCard } from "./cards.testing";

const NOW = new Date("2026-11-07T12:00:00.000Z");

describe("describeCardAloud", () => {
  it("says the noun, the identifier, the title, whose, why, the status and the wait, in that order", () => {
    const card = buildRequestCard("7", {
      title: "Cache slot lookups",
      yours: true,
      reason: { say: "Ines asked for your review", tone: "plain" },
      status: { shape: "ring", tone: "quiet", label: "Draft" },
      waitingSince: "2026-11-05T12:00:00.000Z",
    });
    expect(describeCardAloud(decideCardFace(card), describeCardWait(card, NOW))).toBe(
      "Review, #7, Cache slot lookups, yours, Ines asked for your review, Draft, Waiting 2 days",
    );
  });

  it("leaves out each slot a card does not have", () => {
    const card = buildInboxCard("8", { title: "Fix the cart" });
    expect(describeCardAloud(decideCardFace(card), null)).toBe("Ticket, ACME-8, Fix the cart");
  });

  it.each([
    [1, "Ticket, ACME-8, Fix the cart, with 1 thing riding on it"],
    [3, "Ticket, ACME-8, Fix the cart, with 3 things riding on it"],
  ])("ends with what rides on a card: %s", (riding, words) => {
    const card = buildInboxCard("8", { title: "Fix the cart" });
    expect(describeCardAloud(decideCardFace(card), null, riding)).toBe(words);
  });
});
