/** Tests the Group by and Filter menus. */
import { describe, expect, it } from "vitest";
import { buildInbox, buildInboxCard, buildInboxPlace, buildRequestCard } from "./cards.testing";
import { buildInboxFacets } from "./facets";
import { listInboxGroupings } from "./groupings";

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

describe("listInboxGroupings", () => {
  const two = [
    buildInboxCard("1", { ancestors: [PRICING.ref, TEAM.ref] }),
    buildInboxCard("2", { ancestors: [CHECKOUT.ref] }),
    buildInboxCard("3", { ancestors: [PRICING.ref, TEAM.ref] }),
  ];

  it("offers Place, each kind of place a row lies under by its caption, then Status", () => {
    const inbox = buildInbox(two, { places: [PRICING, CHECKOUT, TEAM] });
    expect(listInboxGroupings(inbox)).toEqual([
      { id: "home", name: "Place" },
      { id: "acme/project", name: "Acme project" },
      { id: "acme/team", name: "Acme team" },
      { id: "status", name: "Status" },
    ]);
  });

  it("offers a kind that only some of the rows lie under, even when most rows lie under none", () => {
    const inbox = buildInbox([...two, buildInboxCard("4"), buildInboxCard("5")], {
      places: [PRICING, CHECKOUT, TEAM],
    });
    expect(listInboxGroupings(inbox).map((grouping) => grouping.id)).toEqual([
      "home",
      "acme/project",
      "acme/team",
      "status",
    ]);
  });

  it("offers each of two kinds that one row lies under, and orders them by caption", () => {
    const linearProject = buildInboxPlace("linear:project:a", "Payments", {
      kind: "linear/project",
      caption: "Linear project",
    });
    const repository = buildInboxPlace("github:repository:a", "shop-web", {
      kind: "github/repository",
      caption: "GitHub repository",
    });
    const inbox = buildInbox(
      [
        buildInboxCard("1", { ancestors: [linearProject.ref] }),
        buildInboxCard("2", { ancestors: [repository.ref] }),
      ],
      { places: [linearProject, repository] },
    );
    expect(listInboxGroupings(inbox).map((grouping) => grouping.name)).toEqual([
      "Place",
      "GitHub repository",
      "Linear project",
      "Status",
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
