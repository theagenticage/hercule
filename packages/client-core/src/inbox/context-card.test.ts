/** Tests the cards drawn under a message that carried context. */
import type { ExternalEntityDetail, InboxThing } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { buildFakeInboxDetail } from "./cards.testing";
import { describeContextCard, describeContextCardFromBlock } from "./context-card";

const THING = {
  id: "ent_1",
  ref: "linear:issue:northwind/SHOP-142",
  kind: "linear/issue",
  noun: "Issue",
  patience: 24,
  identifier: "SHOP-142",
  title: "Show the delivery cost",
  url: "https://example.test/SHOP-142",
  observedAt: "2026-11-01T09:00:00.000Z",
  sourceUpdatedAt: "2026-11-01T09:00:00.000Z",
} as InboxThing;

const buildDetail = (overrides: Partial<ExternalEntityDetail> = {}): ExternalEntityDetail => ({
  ...buildFakeInboxDetail(THING),
  ...overrides,
});

describe("describeContextCard", () => {
  it("draws the source, noun, identifier and title of the thing", () => {
    expect(describeContextCard(buildDetail())).toEqual({
      pluginId: "linear",
      noun: "Issue",
      identifier: "SHOP-142",
      title: "Show the delivery cost",
    });
  });

  it("keeps the status, and ends the line with the face's fact", () => {
    const status = { shape: "most", tone: "active", label: "In Progress" } as const;
    const card = describeContextCard(
      buildDetail({
        status,
        face: { fact: { key: "events", type: "number", label: "Events", number: 1211 } },
      }),
    );
    expect(card.status).toEqual(status);
    expect(card.trailing).toEqual({ kind: "fact", text: "1,211 events" });
  });

  it("ignores the generic facts of the record, such as a diff", () => {
    const card = describeContextCard(
      buildDetail({ facts: [{ form: "delta", added: 142, removed: 38 }] }),
    );
    expect(card).not.toHaveProperty("trailing");
  });

  it("ends the line with the place when the thing has no fact", () => {
    const card = describeContextCard(
      buildDetail({
        face: {
          place: { key: "team", type: "text", label: "Team", text: "Storefront" },
        },
      }),
    );
    expect(card.trailing).toEqual({ kind: "place", text: "Storefront" });
  });

  it("leaves out a place that is an age, because a card has no clock", () => {
    const card = describeContextCard(
      buildDetail({
        face: {
          place: { key: "seen", type: "age", label: "Seen", since: "2026-11-01T09:00:00.000Z" },
        },
      }),
    );
    expect(card).not.toHaveProperty("trailing");
  });
});

describe("describeContextCardFromBlock", () => {
  it("draws the source of the ref and the title the block kept", () => {
    expect(
      describeContextCardFromBlock({ ref: THING.ref, title: "Show the delivery cost" }),
    ).toEqual({
      pluginId: "linear",
      title: "Show the delivery cost",
    });
  });

  it("falls back to the ref when the block kept no title", () => {
    expect(describeContextCardFromBlock({ ref: THING.ref })).toEqual({
      pluginId: "linear",
      title: THING.ref,
    });
  });
});
