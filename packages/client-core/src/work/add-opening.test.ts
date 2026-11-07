/**
 * Tests what the Add sheet opens on: a lane's context, the most common
 * context of a Project lane, a filter on a context or a source, or nothing.
 */
import { describe, expect, it } from "vitest";
import { buildCard, buildPlace } from "./cards.testing";
import { chooseAddOpening } from "./add-opening";
import { buildLane } from "./lanes";

const BASKET = buildPlace("relay:project:basket", "Basket rebuild", { kind: "relay/project" });
const PRICING = buildPlace("relay:project:pricing", "Pricing rules", { kind: "relay/project" });
const REPO = buildPlace("acme:repo:storefront", "acme/storefront-web", {
  kind: "acme/repository",
  noun: "Repository",
  caption: "Acme repository",
});
const PLACES = [BASKET, PRICING, REPO];

describe("chooseAddOpening from a lane", () => {
  it("opens on the place of a lane that stands for one outside place", () => {
    const lane = buildLane(`place:${REPO.ref}`, "acme/storefront-web", null, []);

    expect(chooseAddOpening({ places: PLACES, filter: {}, lane })).toEqual({
      sourceId: "acme",
      scopeRef: REPO.ref,
    });
  });

  it("opens on the context most of a Project lane's cards sit under", () => {
    const lane = buildLane("webshop", "Webshop", "webshop", [
      buildCard("a", { contextRefs: [BASKET.ref, REPO.ref] }),
      buildCard("b", { contextRefs: [PRICING.ref, REPO.ref] }),
      buildCard("c", { contextRefs: [PRICING.ref, REPO.ref] }),
    ]);

    // The repository is under all three cards, the projects under fewer.
    expect(chooseAddOpening({ places: PLACES, filter: {}, lane })).toEqual({
      sourceId: "acme",
      scopeRef: REPO.ref,
    });
  });

  it("breaks a tie by the lower ref, so two reads agree", () => {
    const lane = buildLane("webshop", "Webshop", "webshop", [
      buildCard("a", { contextRefs: [PRICING.ref] }),
      buildCard("b", { contextRefs: [BASKET.ref] }),
    ]);

    expect(chooseAddOpening({ places: PLACES, filter: {}, lane })).toEqual({
      sourceId: "relay",
      scopeRef: BASKET.ref,
    });
  });

  it("opens on everything for a lane whose cards sit under no context", () => {
    const lane = buildLane("webshop", "Webshop", "webshop", [buildCard("a")]);

    expect(chooseAddOpening({ places: PLACES, filter: {}, lane })).toEqual({});
  });

  it("does not let a filter change what a lane opens on", () => {
    const lane = buildLane("webshop", "Webshop", "webshop", [buildCard("a")]);

    expect(
      chooseAddOpening({ places: PLACES, filter: { "acme/repository": [REPO.ref] }, lane }),
    ).toEqual({});
  });
});

describe("chooseAddOpening with no lane", () => {
  it("opens on the context the filter is on", () => {
    const filter = { state: ["failed"], "relay/project": [PRICING.ref] };

    expect(chooseAddOpening({ places: PLACES, filter })).toEqual({
      sourceId: "relay",
      scopeRef: PRICING.ref,
    });
  });

  it("opens on a source the filter is on when no context is chosen", () => {
    expect(chooseAddOpening({ places: PLACES, filter: { source: ["acme"] } })).toEqual({
      sourceId: "acme",
    });
  });

  it("opens on everything with no filter", () => {
    expect(chooseAddOpening({ places: PLACES, filter: {} })).toEqual({});
  });

  it("ignores a filter value that is not a place the user can read", () => {
    const secret = buildPlace("relay:team:secret", "Secret", { restricted: true });

    expect(
      chooseAddOpening({ places: [secret], filter: { "acme/project": [secret.ref] } }),
    ).toEqual({});
  });
});
