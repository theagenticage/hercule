/** Tests the line under a place's name and the rule that spares a row a mark its place shows. */
import { describe, expect, it } from "vitest";
import { buildInbox, buildInboxCard, buildInboxPlace } from "./cards.testing";
import { findSurfaceHeads, buildPlaceContext, HOME_GROUPING } from "./inbox-place";
import { isMarkShownByHead, listSurfaceAboveWords, nameSurface } from "./surface-words";

const PRICING = buildInboxPlace("acme:project:pricing", "Pricing rules");
const SHOP = buildInboxPlace("acme:team:shop", "Shop", { kind: "acme/team", noun: "Team" });
const LOCKED = {
  ref: "acme:initiative:secret",
  kind: "acme/initiative",
  noun: "Initiative",
  restricted: true,
};

const headsOf = (ancestors: string[], places = [PRICING, SHOP, LOCKED]) => {
  const card = buildInboxCard("1", { ancestors });
  const inbox = buildInbox([card], {
    places,
    edges: [
      { fromRef: PRICING.ref, toRef: SHOP.ref },
      { fromRef: PRICING.ref, toRef: LOCKED.ref },
    ],
  });
  return findSurfaceHeads(card, buildPlaceContext(inbox), HOME_GROUPING);
};

describe("listSurfaceAboveWords", () => {
  it("lists what a place is part of, nearest first, and words a place nobody can open", () => {
    const [head] = headsOf([PRICING.ref, SHOP.ref, LOCKED.ref]);
    expect(listSurfaceAboveWords(head!, [{ id: "acme", displayName: "Acme" }])).toEqual([
      "Shop",
      "An Acme initiative you cannot open",
    ]);
  });

  it("is empty for a head that is not a place", () => {
    const [head] = headsOf([]);
    expect(head?._tag).toBe("source");
    expect(listSurfaceAboveWords(head!, [])).toEqual([]);
  });
});

describe("isMarkShownByHead", () => {
  it("is true for a place or a source of the same plugin, and false for any other head", () => {
    const [place] = headsOf([PRICING.ref]);
    expect(isMarkShownByHead(place!, "acme")).toBe(true);
    expect(isMarkShownByHead(place!, "other")).toBe(false);
    const [source] = headsOf([]);
    expect(isMarkShownByHead(source!, "acme")).toBe(true);
    expect(
      isMarkShownByHead({ _tag: "plain", id: "status:none", title: "No status" }, "acme"),
    ).toBe(false);
  });

  it("is false for a place the user cannot open, which shows a lock", () => {
    const card = buildInboxCard("1", { ancestors: [LOCKED.ref], home: "acme/initiative" });
    const inbox = buildInbox([card], { places: [LOCKED] });
    const [head] = findSurfaceHeads(card, buildPlaceContext(inbox), HOME_GROUPING);
    expect(head?._tag).toBe("place");
    expect(isMarkShownByHead(head!, "acme")).toBe(false);
  });
});

describe("nameSurface", () => {
  const plugins = [{ id: "acme", displayName: "Acme" }];

  it("names a place by its title, a source by its plugin and a plain head by its title", () => {
    const [place] = headsOf([PRICING.ref]);
    const [source] = headsOf([]);
    expect(nameSurface(place!, plugins)).toBe("Pricing rules");
    expect(nameSurface(source!, plugins)).toBe("Acme");
    expect(nameSurface({ _tag: "plain", id: "status:none", title: "No status" }, plugins)).toBe(
      "No status",
    );
  });

  it("words a place nobody can open as a locked row", () => {
    const card = buildInboxCard("1", { ancestors: [LOCKED.ref], home: "acme/initiative" });
    const inbox = buildInbox([card], { places: [LOCKED] });
    const [head] = findSurfaceHeads(card, buildPlaceContext(inbox), HOME_GROUPING);
    expect(nameSurface(head!, plugins)).toBe("An Acme initiative you cannot open");
  });
});
