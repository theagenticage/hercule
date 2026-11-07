/**
 * Tests the Filter facets for outside places that Work and the Inbox share:
 * one facet per kind, which places are listed and in what order, and which
 * items have a value.
 */
import { describe, expect, it } from "vitest";
import type { EntityPlace } from "@hercule/contract";
import { buildPlaceFacets } from "./place-facets";

/** Returns a place, with the noun "Project" and the caption "Acme project" unless told otherwise. A place with no title is one the user cannot read. */
const buildPlace = (
  ref: string,
  kind: string,
  title: string | undefined,
  words: { readonly noun: string; readonly caption?: string } = {
    noun: "Project",
    caption: "Acme project",
  },
): EntityPlace => ({
  ref,
  kind,
  ...words,
  restricted: title === undefined,
  ...(title === undefined ? {} : { title }),
});

interface Item {
  readonly refs: readonly string[];
}

const listRefs = (item: Item): readonly string[] => item.refs;

describe("buildPlaceFacets", () => {
  const places = [
    buildPlace("acme:project:pricing", "acme/project", "Pricing rules"),
    buildPlace("acme:project:basket", "acme/project", "Basket rebuild"),
    buildPlace("acme:project:hidden", "acme/project", undefined),
    buildPlace("relay:team:web", "relay/team", "Web", { noun: "Team" }),
    buildPlace("relay:team:secret", "relay/team", undefined, { noun: "Team" }),
  ];

  it("makes one facet per kind, ordered by caption, with its places ordered by title", () => {
    const facets = buildPlaceFacets(places, listRefs);

    expect(facets.map((facet) => [facet.id, facet.caption])).toEqual([
      ["acme/project", "Acme project"],
      ["relay/team", "Team"],
    ]);
    expect(facets[0]!.values.map((value) => value.name)).toEqual([
      "Basket rebuild",
      "Pricing rules",
    ]);
  });

  it("leaves out a place the user cannot read, and a kind with only such places", () => {
    const facets = buildPlaceFacets(
      [
        buildPlace("acme:project:hidden", "acme/project", undefined),
        buildPlace("relay:team:web", "relay/team", "Web"),
      ],
      listRefs,
    );

    expect(facets.map((facet) => facet.id)).toEqual(["relay/team"]);
  });

  it("puts the heading over every facet when it is given", () => {
    expect(buildPlaceFacets(places, listRefs, "From your sources").map((f) => f.heading)).toEqual([
      "From your sources",
      "From your sources",
    ]);
    expect(buildPlaceFacets(places, listRefs).map((f) => f.heading)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("tells that an item has a place by the refs it lists", () => {
    const [acme] = buildPlaceFacets(places, listRefs);

    expect(acme!.hasValue({ refs: ["acme:project:basket"] }, "acme:project:basket")).toBe(true);
    expect(acme!.hasValue({ refs: [] }, "acme:project:basket")).toBe(false);
  });
});
