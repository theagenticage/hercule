/** Tests where a single card lies, through `decideInboxPlace`, and the Group by and Filter menus. */
import { describe, expect, it } from "vitest";
import { buildInbox, buildInboxCard, buildInboxPlace, buildRequestCard } from "./cards.testing";
import { buildInboxFacets } from "./facets";
import { listInboxGroupings } from "./groupings";
import { decideInboxPlace, HOME_GROUPING } from "./inbox-place";

const PRICING = buildInboxPlace("acme:project:pricing", "Pricing rules");
const CHECKOUT = buildInboxPlace("acme:project:checkout", "Checkout");
const TEAM = buildInboxPlace("acme:team:shop", "Shop team", {
  kind: "acme/team",
  noun: "Team",
  caption: "Acme team",
});
const SHOP_WEB = buildInboxPlace("acme:repository:shop-web", "shop-web", {
  kind: "acme/repository",
  noun: "Repository",
  caption: "Acme repository",
});

describe("decideInboxPlace", () => {
  it("puts a rich card on the surface of each home, in the order of its ancestors", () => {
    const card = buildInboxCard("1", { ancestors: [CHECKOUT.ref, TEAM.ref, PRICING.ref] });
    const inbox = buildInbox([card], { places: [PRICING, CHECKOUT, TEAM] });
    const place = decideInboxPlace(card, inbox);
    expect(place).toMatchObject({ _tag: "surfaces" });
    expect(place._tag === "surfaces" && place.heads.map((head) => head.id)).toEqual([
      CHECKOUT.ref,
      PRICING.ref,
    ]);
  });

  it("puts a rich card with no home on a surface named for its plugin", () => {
    const card = buildInboxCard("1", { ancestors: [TEAM.ref] });
    const inbox = buildInbox([card], { places: [TEAM] });
    expect(decideInboxPlace(card, inbox, HOME_GROUPING)).toEqual({
      _tag: "surfaces",
      heads: [{ _tag: "source", id: "source:acme", pluginId: "acme" }],
    });
  });

  it("puts a compact card in Requests under its home's name", () => {
    const card = buildRequestCard("1", { ancestors: [SHOP_WEB.ref] });
    const inbox = buildInbox([card], { places: [SHOP_WEB] });
    expect(decideInboxPlace(card, inbox)).toEqual({ _tag: "request", homeName: "shop-web" });
  });

  it("names no home for a request with none, or whose home is locked", () => {
    const locked = {
      ref: SHOP_WEB.ref,
      kind: SHOP_WEB.kind,
      noun: SHOP_WEB.noun,
      restricted: true,
    };
    const card = buildRequestCard("1", { ancestors: [locked.ref] });
    const inbox = buildInbox([card], { places: [locked] });
    expect(decideInboxPlace(card, inbox)).toEqual({ _tag: "request", homeName: undefined });
  });
});

describe("listInboxGroupings", () => {
  const two = [
    buildInboxCard("1", { ancestors: [PRICING.ref, TEAM.ref] }),
    buildInboxCard("2", { ancestors: [CHECKOUT.ref] }),
    buildInboxCard("3", { ancestors: [PRICING.ref, TEAM.ref] }),
  ];

  it("offers Place, each kind of place most rows lie under by its caption, then Status", () => {
    const inbox = buildInbox(two, { places: [PRICING, CHECKOUT, TEAM] });
    expect(listInboxGroupings(inbox)).toEqual([
      { id: "home", name: "Place" },
      { id: "acme/project", name: "Acme project" },
      { id: "acme/team", name: "Acme team" },
      { id: "status", name: "Status" },
    ]);
  });

  it("leaves out a kind that half the rows or fewer lie under", () => {
    const inbox = buildInbox([...two, buildInboxCard("4"), buildInboxCard("5")], {
      places: [PRICING, CHECKOUT, TEAM],
    });
    expect(listInboxGroupings(inbox).map((grouping) => grouping.id)).toEqual([
      "home",
      "acme/project",
      "status",
    ]);
  });

  it("does not count requests, and offers a level that is itself a card never", () => {
    const parent = buildInboxCard("9", { ref: PRICING.ref });
    const inbox = buildInbox(
      [parent, buildRequestCard("1", { ancestors: [PRICING.ref] }), two[0]!],
      {
        places: [PRICING],
      },
    );
    expect(listInboxGroupings(inbox).map((grouping) => grouping.id)).toEqual(["home", "status"]);
  });
});

describe("buildInboxFacets", () => {
  const inbox = buildInbox(
    [
      buildInboxCard("1", { ancestors: [PRICING.ref, TEAM.ref] }),
      buildRequestCard("2", { ancestors: [SHOP_WEB.ref] }),
    ],
    {
      places: [
        PRICING,
        CHECKOUT,
        TEAM,
        SHOP_WEB,
        { ...buildInboxPlace("acme:project:hidden", "x"), restricted: true, kind: "acme/secret" },
      ],
    },
  );

  it("offers whose it is, then a facet for each kind of place that lies above a card", () => {
    const facets = buildInboxFacets(inbox);
    expect(facets.map((facet) => [facet.id, facet.caption])).toEqual([
      ["whose", ""],
      ["acme/project", "Acme project"],
      ["acme/repository", "Acme repository"],
      ["acme/team", "Acme team"],
    ]);
    expect(facets[0]?.values.map((value) => value.name)).toEqual(["Mine", "Other people's"]);
    expect(facets[1]?.values).toEqual([{ id: PRICING.ref, name: "Pricing rules" }]);
  });

  it("tells a card has a place's value when the place is anywhere above it", () => {
    const [, project] = buildInboxFacets(inbox);
    const [first, second] = inbox.cards;
    expect(first && project?.hasValue(first, PRICING.ref)).toBe(true);
    expect(second && project?.hasValue(second, PRICING.ref)).toBe(false);
  });
});
