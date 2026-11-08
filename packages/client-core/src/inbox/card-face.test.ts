/** Tests what the generic card draws for a card, with invented kinds. */
import type { EntityFact, EntityStatus } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { buildInboxCard, buildRequestCard, buildSignalLine } from "./cards.testing";
import { decideAskingSentence, decideCardFace, readSentenceSignal } from "./card-face";

const TESSA = { name: "Tessa Hart" };
const APPROVED: EntityStatus = { shape: "check", tone: "good", label: "Approved" };
const OPEN: EntityStatus = { shape: "ring", tone: "active", label: "Open", norm: true };
const DRAFT: EntityStatus = { shape: "dashed", tone: "quiet", label: "Draft" };
const FAILING: EntityStatus = { shape: "cross", tone: "bad", label: "Checks failed" };

describe("decideCardFace", () => {
  it("reads the plugin from the qualified kind, whatever the kind is", () => {
    expect(decideCardFace(buildInboxCard("1", { kind: "quayside/purchase-order" })).pluginId).toBe(
      "quayside",
    );
    expect(decideCardFace(buildInboxCard("1", { kind: "acme/ticket" })).pluginId).toBe("acme");
  });

  it("copies the title, noun and identifier", () => {
    expect(
      decideCardFace(buildInboxCard("7", { title: "Refund flow", noun: "Ticket" })),
    ).toMatchObject({
      title: "Refund flow",
      noun: "Ticket",
      identifier: "ACME-7",
    });
  });

  describe("status", () => {
    it.each([OPEN, DRAFT, APPROVED, FAILING])("always shows $label on a row", (status) => {
      expect(decideCardFace(buildInboxCard("1", { status })).status).toEqual(status);
    });

    it.each([
      [OPEN, false],
      [DRAFT, true],
      [APPROVED, true],
      [FAILING, true],
      [{ shape: "hold", tone: "attention", label: "Changes requested" } as const, true],
    ])("shows %j on a request only when it is not the norm: %s", (status, shown) => {
      const face = decideCardFace(buildRequestCard("1", { status }));
      expect(face.status !== undefined).toBe(shown);
    });

    it("has no status for a kind without one", () => {
      expect(decideCardFace(buildInboxCard("1"))).not.toHaveProperty("status");
    });
  });

  describe("sentence", () => {
    const reason = { say: "Mei asked for your review", tone: "plain" } as const;

    it("keeps the full reason on a row", () => {
      expect(decideCardFace(buildInboxCard("1", { reason, person: TESSA })).sentence).toEqual({
        text: "Mei asked for your review",
        tone: "plain",
      });
    });

    it("reduces the usual reason of a request to the person's name", () => {
      expect(decideCardFace(buildRequestCard("1", { reason, person: TESSA })).sentence).toEqual({
        text: "Tessa Hart",
        tone: "plain",
      });
    });

    it.each([
      ["a toned reason", { say: "Checks failed again", tone: "bad" as const }, TESSA],
      ["a request with no person", reason, undefined],
    ])("keeps the full reason of a request for %s", (_name, kept, person) => {
      const card = buildRequestCard("1", { reason: kept, ...(person ? { person } : {}) });
      expect(decideCardFace(card).sentence).toEqual({ text: kept.say, tone: kept.tone });
    });

    it("has no sentence without a reason", () => {
      expect(decideCardFace(buildInboxCard("1"))).not.toHaveProperty("sentence");
    });
  });

  describe("whose", () => {
    it.each([
      ["a colleague's row", buildInboxCard("1", { person: TESSA }), "Tessa Hart's"],
      ["your own row", buildInboxCard("1", { person: TESSA, yours: true }), undefined],
      ["a row with no person", buildInboxCard("1"), undefined],
      ["your request", buildRequestCard("1", { yours: true, person: TESSA }), "yours"],
      ["a colleague's request", buildRequestCard("1", { person: TESSA }), undefined],
    ])("says %s as %s", (_name, card, whose) => {
      expect(decideCardFace(card).whose).toBe(whose);
    });
  });

  describe("facts", () => {
    it.each<[EntityFact, object]>([
      [
        { form: "delta", added: 120, removed: 30 },
        { form: "delta", text: "+120 −30", added: "+120", removed: "−30" },
      ],
      [
        { form: "count", value: 1, unit: "file" },
        { form: "count", text: "1 file" },
      ],
      [
        { form: "count", value: 1200, unit: "event" },
        { form: "count", text: "1,200 events" },
      ],
      [
        { form: "word", text: "Urgent" },
        { form: "word", text: "Urgent" },
      ],
      [
        { form: "date", on: "2026-11-14T00:00:00.000Z" },
        { form: "date", text: "Due 14 Nov" },
      ],
      [
        { form: "money", text: "EUR 1,250.00" },
        { form: "money", text: "EUR 1,250.00" },
      ],
      [
        { form: "bars", level: 2 },
        { form: "bars", text: "2 of 3", level: 2 },
      ],
    ])("writes %j as display strings", (fact, expected) => {
      expect(decideCardFace(buildInboxCard("1", { facts: [fact] })).facts).toEqual([expected]);
    });
  });
});

describe("the sentence of a card with signals", () => {
  const commented = buildSignalLine("s1", "Tessa commented", { asker: "Tessa Hart" });
  const assigned = buildSignalLine("s2", "Assigned to you", { kind: "acme/assigned" });

  it("draws the latest signal's sentence in place of the observation's reason", () => {
    const card = buildInboxCard("1", {
      reason: { say: "Assigned to you", tone: "plain" },
      signals: { openCount: 2, latest: commented },
    });
    expect(decideCardFace(card).sentence).toEqual({ text: "Tessa commented", tone: "plain" });
  });

  it("keeps the tone of the latest signal", () => {
    const failed = buildSignalLine("s3", "Checks failed", {
      say: { say: "Checks failed", tone: "bad" },
    });
    const card = buildRequestCard("1", { signals: { openCount: 1, latest: failed } });
    expect(decideCardFace(card).sentence).toEqual({ text: "Checks failed", tone: "bad" });
  });

  it("reduces a request's plain signal to the name of whoever it came from", () => {
    const card = buildRequestCard("1", { signals: { openCount: 1, latest: commented } });
    expect(decideCardFace(card).sentence).toEqual({ text: "Tessa Hart", tone: "plain" });
  });

  it("says nothing on a row that has only been assigned", () => {
    const card = buildInboxCard("1", {
      concerns: ["assigned"],
      signals: { openCount: 1, latest: assigned },
    });
    expect(decideCardFace(card)).not.toHaveProperty("sentence");
    expect(readSentenceSignal(card)).toBeUndefined();
  });

  it.each([
    ["a second open signal", { openCount: 2, latest: assigned }],
    ["a signal that is not its concern", { openCount: 1, latest: commented }],
  ])("says the latest signal on a row with %s", (_name, signals) => {
    const card = buildInboxCard("1", { concerns: ["assigned"], signals });
    expect(readSentenceSignal(card)).toBe(signals.latest);
    expect(decideCardFace(card)).toHaveProperty("sentence");
  });

  it("keeps the assigned sentence of a request, which a request always shows", () => {
    const card = buildRequestCard("1", {
      concerns: ["assigned"],
      signals: { openCount: 1, latest: assigned },
    });
    expect(readSentenceSignal(card)).toBe(assigned);
  });
});

describe("decideAskingSentence", () => {
  const failed = buildSignalLine("s1", "Checks failed", {
    say: { say: "Checks failed", tone: "bad" },
    asker: "Ines Duarte",
  });

  it("keeps the full sentence, and its tone on the user's own work", () => {
    const card = buildRequestCard("1", { yours: true, signals: { openCount: 1, latest: failed } });
    expect(decideAskingSentence(card)).toEqual({ text: "Checks failed", tone: "bad" });
  });

  it("draws someone else's sentence plain, because their red stays in the status shape", () => {
    const card = buildRequestCard("1", { signals: { openCount: 1, latest: failed } });
    expect(decideAskingSentence(card)).toEqual({ text: "Checks failed", tone: "plain" });
  });

  it("falls back to the observation's reason, and to nothing", () => {
    const reason = { say: "Ines asked for your review", tone: "plain" } as const;
    expect(decideAskingSentence(buildRequestCard("1", { reason }))).toEqual({
      text: "Ines asked for your review",
      tone: "plain",
    });
    expect(decideAskingSentence(buildRequestCard("1"))).toBeUndefined();
  });
});
