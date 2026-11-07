/**
 * The toolbar's filter, for any list of items (the Work board's cards, the
 * Inbox's rows). A filter is a set of facets, such as State or Project, each
 * with the values the user chose. The rules:
 *
 * - values of one facet add up: an item passes a facet when it has any one of
 *   the chosen values;
 * - facets narrow: an item passes the filter when it passes every facet that
 *   has a chosen value.
 *
 * The functions are pure. The Find box is not part of the filter: the caller
 * narrows the items by their title first, and passes what is left.
 */

/** One value a facet can take, such as the project "Pricing rules". */
export interface FilterValue {
  /** What the filter stores for this value. */
  readonly id: string;
  /** What the menu and the chip show. */
  readonly name: string;
  /**
   * Set on a value that goes off by itself once no item has it, such as
   * Failed: an empty page says nothing. Other values stay on until the user
   * turns them off.
   */
  readonly liftsItself?: true;
}

/** The heading over the outside places a source reports, in the Group by and the Filter menus. */
export const FROM_YOUR_SOURCES_HEADING = "From your sources";

/** One way to filter the items, and how to tell whether an item has a value of it. */
export interface FilterFacet<Item> {
  /** What the filter stores for this facet, such as "project". */
  readonly id: string;
  /**
   * The word a chip shows before the value, such as "Project". Empty for the
   * State facet, whose values ("Failed") read well alone.
   */
  readonly caption: string;
  /**
   * A quiet heading the menu puts over this facet's row, such as "From your
   * sources". Facets that follow one another with the same heading sit under
   * one copy of it.
   */
  readonly heading?: string;
  /** The values the menu lists, in order. */
  readonly values: readonly FilterValue[];
  /** Returns whether `item` has the value with this id. */
  readonly hasValue: (item: Item, valueId: string) => boolean;
}

/** The chosen values of each facet, by facet id. A facet with no chosen value has no entry. */
export type Filter = Readonly<Record<string, readonly string[]>>;

/** The filter with nothing chosen. Clearing a filter is replacing it with this. */
export const EMPTY_FILTER: Filter = {};

/** What a chip shows, and which value clicking it removes. */
export interface FilterChipWords {
  readonly facetId: string;
  readonly valueId: string;
  /** The facet's `caption`: empty or the word before the value. */
  readonly caption: string;
  /** The value's name. */
  readonly name: string;
}

/** Returns whether any value is chosen. */
export const isFilterOn = (filter: Filter): boolean => Object.keys(filter).length > 0;

/**
 * Returns the filter with the value turned on if it was off, or off if it was
 * on. A facet whose last value is turned off leaves the filter.
 */
export const toggleFilterValue = (filter: Filter, facetId: string, valueId: string): Filter => {
  const chosen = filter[facetId] ?? [];
  const next = chosen.includes(valueId)
    ? chosen.filter((id) => id !== valueId)
    : [...chosen, valueId];
  const others = Object.entries(filter).filter(([id]) => id !== facetId);
  return Object.fromEntries(next.length === 0 ? others : [...others, [facetId, next]]);
};

/**
 * Returns one chip per chosen value, in the order of `facets` and then of the
 * choosing. A value that its facet does not list shows its id as its name, so
 * a filter that hides items always has a chip to remove it.
 */
export const buildFilterChips = <Item>(
  filter: Filter,
  facets: readonly FilterFacet<Item>[],
): readonly FilterChipWords[] =>
  facets.flatMap((facet) =>
    (filter[facet.id] ?? []).map((valueId) => ({
      facetId: facet.id,
      valueId,
      caption: facet.caption,
      name: facet.values.find((value) => value.id === valueId)?.name ?? valueId,
    })),
  );

/** Returns whether `item` passes the facet: the facet has no chosen value, or the item has one of them. */
const passesFacet = <Item>(item: Item, facet: FilterFacet<Item>, filter: Filter): boolean => {
  const chosen = filter[facet.id] ?? [];
  return chosen.length === 0 || chosen.some((valueId) => facet.hasValue(item, valueId));
};

/** Returns the items that pass every facet except `skipped`, in their order. */
const filterExcept = <Item>(
  items: readonly Item[],
  filter: Filter,
  facets: readonly FilterFacet<Item>[],
  skipped: FilterFacet<Item> | undefined,
): readonly Item[] =>
  items.filter((item) =>
    facets.every((facet) => facet === skipped || passesFacet(item, facet, filter)),
  );

/** Returns the items that pass the filter, in their order. */
export const filterItems = <Item>(
  items: readonly Item[],
  filter: Filter,
  facets: readonly FilterFacet<Item>[],
): readonly Item[] => filterExcept(items, filter, facets, undefined);

/**
 * Returns, for each value of `facet`, how many items the filter would leave
 * if the user chose that value. The facet's own choices are left out of the
 * count, so a value next to a chosen one shows what it would add, not zero.
 * Every other facet narrows as chosen.
 *
 * The result has an entry for every value of the facet, also those that leave
 * nothing. The caller decides whether to show a value that leaves 0.
 */
export const countFacetValues = <Item>(
  items: readonly Item[],
  filter: Filter,
  facets: readonly FilterFacet<Item>[],
  facet: FilterFacet<Item>,
): Readonly<Record<string, number>> => {
  const narrowed = filterExcept(items, filter, facets, facet);
  return Object.fromEntries(
    facet.values.map((value) => [
      value.id,
      narrowed.filter((item) => facet.hasValue(item, value.id)).length,
    ]),
  );
};

/**
 * Returns the filter without the chosen values that lift themselves
 * (`FilterValue.liftsItself`) and that no item has any more, so that ending
 * the last failure lifts the Failed filter instead of leaving an empty page.
 * `items` is every item, not the ones the filter leaves: a value is dropped
 * only when nothing at all has it, never because another facet narrows it away.
 *
 * Returns `filter` itself when nothing is dropped, so a caller can tell
 * without comparing. Call it only with items that were read: an empty list
 * that is still loading would drop every such value.
 */
export const dropEmptyValues = <Item>(
  filter: Filter,
  facets: readonly FilterFacet<Item>[],
  items: readonly Item[],
): Filter => {
  let next = filter;
  for (const facet of facets) {
    for (const valueId of filter[facet.id] ?? []) {
      const lifts = facet.values.find((value) => value.id === valueId)?.liftsItself === true;
      if (lifts && !items.some((item) => facet.hasValue(item, valueId))) {
        next = toggleFilterValue(next, facet.id, valueId);
      }
    }
  }
  return next;
};
