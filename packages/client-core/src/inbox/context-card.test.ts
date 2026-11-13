/** Tests the cards drawn under a message that carried context. */
import type { EntityCard } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { ApiError } from "../errors";
import {
  describeContextCard,
  describeContextCardFromBlock,
  shouldRetryCardsRead,
} from "./context-card";

const REF = "linear:issue:northwind/SHOP-142";

const buildCard = (overrides: Partial<EntityCard> = {}): EntityCard => ({
  id: "ent_1",
  ref: REF,
  kind: "linear/issue",
  noun: "Issue",
  identifier: "SHOP-142",
  title: "Show the delivery cost",
  face: null,
  restricted: false,
  ...overrides,
});

describe("describeContextCard", () => {
  it("draws the source, noun, identifier and title of the thing", () => {
    expect(describeContextCard(buildCard())).toEqual({
      pluginId: "linear",
      noun: "Issue",
      identifier: "SHOP-142",
      title: "Show the delivery cost",
    });
  });

  it("keeps the status, and ends the line with the face's fact", () => {
    const status = { shape: "most", tone: "active", label: "In Progress" } as const;
    const card = describeContextCard(
      buildCard({
        status,
        face: { fact: { key: "events", type: "number", label: "Events", number: 1211 } },
      }),
    );
    expect(card.status).toEqual(status);
    expect(card.trailing).toEqual({ kind: "fact", text: "1,211 events" });
  });

  it("has no trailing words when the thing has no face", () => {
    expect(describeContextCard(buildCard())).not.toHaveProperty("trailing");
  });

  it("is a locked card, with no title or identifier, for a restricted thing", () => {
    const card = describeContextCard(
      buildCard({
        restricted: true,
        identifier: "SHOP-142",
        title: "Secret",
        status: { shape: "most", tone: "active", label: "In Progress" },
      }),
    );
    expect(card).toEqual({
      pluginId: "linear",
      noun: "Issue",
      title: "An issue you cannot open",
      isLocked: true,
    });
  });

  it("falls back to the ref when the thing has no title", () => {
    const untitled = buildCard();
    delete (untitled as { title?: string }).title;
    expect(describeContextCard(untitled).title).toBe(REF);
  });

  it("ends the line with the place when the thing has no fact", () => {
    const card = describeContextCard(
      buildCard({
        face: {
          place: { key: "team", type: "text", label: "Team", text: "Storefront" },
        },
      }),
    );
    expect(card.trailing).toEqual({ kind: "place", text: "Storefront" });
  });

  it("leaves out a place that is an age, because a card has no clock", () => {
    const card = describeContextCard(
      buildCard({
        face: {
          place: { key: "seen", type: "age", label: "Seen", since: "2026-11-01T09:00:00.000Z" },
        },
      }),
    );
    expect(card).not.toHaveProperty("trailing");
  });
});

describe("the plugin of a card", () => {
  it("is the entity's kind for a card that was read, and a guess from the ref's system otherwise", () => {
    const ref = "github:pr:northwind/web#6244";
    expect(describeContextCard(buildCard({ ref, kind: "acme/pull-request" })).pluginId).toBe(
      "acme",
    );
    expect(describeContextCardFromBlock({ ref }).pluginId).toBe("github");
  });
});

describe("shouldRetryCardsRead", () => {
  it.each(["not_found", "forbidden"] as const)("does not retry a read refused as %s", (code) => {
    expect(shouldRetryCardsRead(1, new ApiError(code, "No."))).toBe(false);
  });

  it("retries another failure up to three times", () => {
    const error = new ApiError("internal", "Down.");
    expect(shouldRetryCardsRead(1, error)).toBe(true);
    expect(shouldRetryCardsRead(2, error)).toBe(true);
    expect(shouldRetryCardsRead(3, error)).toBe(false);
  });
});

describe("describeContextCardFromBlock", () => {
  it("draws the source of the ref and the title the block kept", () => {
    expect(describeContextCardFromBlock({ ref: REF, title: "Show the delivery cost" })).toEqual({
      pluginId: "linear",
      title: "Show the delivery cost",
    });
  });

  it("falls back to the ref when the block kept no title", () => {
    expect(describeContextCardFromBlock({ ref: REF })).toEqual({
      pluginId: "linear",
      title: REF,
    });
  });
});
