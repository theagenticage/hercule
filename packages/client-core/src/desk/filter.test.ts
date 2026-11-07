/**
 * Tests the toolbar's filter: that values of one facet add up and facets
 * narrow, what each filter value would leave, and when a value lifts itself.
 */
import { describe, expect, it } from "vitest";
import {
  buildFilterChips,
  countFacetValues,
  dropEmptyValues,
  EMPTY_FILTER,
  filterItems,
  isFilterOn,
  toggleFilterValue,
  type Filter,
  type FilterFacet,
} from "./filter";

interface Card {
  readonly id: string;
  readonly project: string;
  readonly failed: boolean;
  readonly asking: boolean;
}

const STATE: FilterFacet<Card> = {
  id: "state",
  caption: "",
  values: [
    { id: "question", name: "Has a question", liftsItself: true },
    { id: "failed", name: "Failed", liftsItself: true },
  ],
  hasValue: (card, valueId) => (valueId === "failed" ? card.failed : card.asking),
};

const PROJECT: FilterFacet<Card> = {
  id: "project",
  caption: "Project",
  values: [
    { id: "depots", name: "Depot returns" },
    { id: "pricing", name: "Pricing rules" },
    { id: "baskets", name: "Basket sync" },
  ],
  hasValue: (card, valueId) => card.project === valueId,
};

const FACETS = [STATE, PROJECT];

const CARDS: readonly Card[] = [
  { id: "a", project: "depots", failed: true, asking: false },
  { id: "b", project: "depots", failed: false, asking: true },
  { id: "c", project: "pricing", failed: true, asking: false },
  { id: "d", project: "pricing", failed: false, asking: false },
];

const ids = (cards: readonly Card[]): string[] => cards.map((card) => card.id);

describe("toggleFilterValue", () => {
  it.each<{ name: string; filter: Filter; facet: string; value: string; expected: Filter }>([
    {
      name: "turns a value on",
      filter: {},
      facet: "state",
      value: "failed",
      expected: { state: ["failed"] },
    },
    {
      name: "adds a second value to its facet",
      filter: { state: ["failed"] },
      facet: "state",
      value: "question",
      expected: { state: ["failed", "question"] },
    },
    {
      name: "keeps the other facets",
      filter: { state: ["failed"] },
      facet: "project",
      value: "depots",
      expected: { state: ["failed"], project: ["depots"] },
    },
    {
      name: "turns a value off",
      filter: { state: ["failed", "question"] },
      facet: "state",
      value: "failed",
      expected: { state: ["question"] },
    },
    {
      name: "removes a facet once its last value is off",
      filter: { state: ["failed"], project: ["depots"] },
      facet: "state",
      value: "failed",
      expected: { project: ["depots"] },
    },
  ])("$name", ({ filter, facet, value, expected }) => {
    expect(toggleFilterValue(filter, facet, value)).toEqual(expected);
  });

  it("does not change the filter it was given", () => {
    const filter: Filter = { state: ["failed"] };
    toggleFilterValue(filter, "state", "failed");
    expect(filter).toEqual({ state: ["failed"] });
  });
});

describe("isFilterOn", () => {
  it("is true once a value is chosen and false after clearing", () => {
    const filter = toggleFilterValue(EMPTY_FILTER, "state", "failed");
    expect(isFilterOn(filter)).toBe(true);
    expect(isFilterOn(EMPTY_FILTER)).toBe(false);
  });
});

describe("filterItems", () => {
  it.each<{ name: string; filter: Filter; expected: string[] }>([
    { name: "leaves everything with nothing chosen", filter: {}, expected: ["a", "b", "c", "d"] },
    {
      name: "adds up the values of one facet",
      filter: { state: ["failed", "question"] },
      expected: ["a", "b", "c"],
    },
    {
      name: "narrows by the facets together",
      filter: { state: ["failed"], project: ["pricing"] },
      expected: ["c"],
    },
    {
      name: "leaves nothing when no item has the value",
      filter: { state: ["question"], project: ["pricing"] },
      expected: [],
    },
  ])("$name", ({ filter, expected }) => {
    expect(ids(filterItems(CARDS, filter, FACETS))).toEqual(expected);
  });
});

describe("buildFilterChips", () => {
  it("builds one chip per chosen value, in the order of the facets", () => {
    const filter: Filter = { project: ["pricing", "depots"], state: ["failed"] };
    expect(buildFilterChips(filter, FACETS)).toEqual([
      { facetId: "state", valueId: "failed", caption: "", name: "Failed" },
      { facetId: "project", valueId: "pricing", caption: "Project", name: "Pricing rules" },
      { facetId: "project", valueId: "depots", caption: "Project", name: "Depot returns" },
    ]);
  });

  it("shows the id of a value its facet does not list, so the filter can still be removed", () => {
    expect(buildFilterChips({ project: ["gone"] }, FACETS)).toEqual([
      { facetId: "project", valueId: "gone", caption: "Project", name: "gone" },
    ]);
  });
});

describe("countFacetValues", () => {
  it("counts every value against the other facets only", () => {
    expect(countFacetValues(CARDS, {}, FACETS, PROJECT)).toEqual({
      depots: 2,
      pricing: 2,
      baskets: 0,
    });
    expect(countFacetValues(CARDS, { state: ["failed"] }, FACETS, PROJECT)).toEqual({
      depots: 1,
      pricing: 1,
      baskets: 0,
    });
  });

  it("leaves the facet's own choices out, so a neighbour shows what it would add", () => {
    expect(countFacetValues(CARDS, { project: ["depots"] }, FACETS, PROJECT)).toEqual({
      depots: 2,
      pricing: 2,
      baskets: 0,
    });
    expect(
      countFacetValues(CARDS, { project: ["depots"], state: ["failed"] }, FACETS, STATE),
    ).toEqual({ question: 1, failed: 1 });
  });
});

describe("dropEmptyValues", () => {
  it("drops a state value once no item has it", () => {
    const withoutFailures = CARDS.filter((card) => !card.failed);
    expect(dropEmptyValues({ state: ["failed", "question"] }, FACETS, withoutFailures)).toEqual({
      state: ["question"],
    });
    expect(dropEmptyValues({ state: ["failed"] }, FACETS, withoutFailures)).toEqual({});
  });

  it("keeps a value that another facet narrows to nothing", () => {
    const filter: Filter = { state: ["failed"], project: ["baskets"] };
    const cards = [...CARDS, { id: "e", project: "baskets", failed: false, asking: false }];
    expect(dropEmptyValues(filter, FACETS, cards)).toBe(filter);
  });

  it("keeps a value that does not lift itself, even when no item has it", () => {
    const filter: Filter = { project: ["baskets"] };
    expect(dropEmptyValues(filter, FACETS, CARDS)).toBe(filter);
  });
});
