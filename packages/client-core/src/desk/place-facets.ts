import type { EntityPlace } from "@hercule/contract";
import type { FilterFacet, FilterValue } from "./filter";

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Returns one Filter facet for each kind of outside place in `places`, so the
 * Work board and the Inbox filter by place in the same way.
 *
 * - A facet's id is the kind, and its caption is the kind's words ("Linear
 *   project"), or the noun when the kind has no caption. Facets are ordered
 *   by caption, then by kind.
 * - A facet's values are the places of that kind, ordered by title, then by
 *   ref. A place the user cannot read has no title to show and is left out, so
 *   a kind with only such places has no facet.
 * - An item has a value when `listPlaceRefs(item)` holds its ref.
 * - `heading`, when given, is the menu heading over each facet.
 *
 * The caller decides which places can be filtered by: pass only those.
 */
export const buildPlaceFacets = <Item>(
  places: readonly EntityPlace[],
  listPlaceRefs: (item: Item) => readonly string[],
  heading?: string,
): readonly FilterFacet<Item>[] => {
  const kinds = new Map<string, { caption: string; values: FilterValue[] }>();
  for (const place of places) {
    if (place.title === undefined) continue;
    const kind = kinds.get(place.kind) ?? { caption: place.caption ?? place.noun, values: [] };
    kind.values.push({ id: place.ref, name: place.title });
    kinds.set(place.kind, kind);
  }
  return [...kinds]
    .map(([kind, { caption, values }]): FilterFacet<Item> => ({
      id: kind,
      caption,
      ...(heading === undefined ? {} : { heading }),
      values: values.toSorted(
        (a, b) => a.name.localeCompare(b.name, "en") || compareText(a.id, b.id),
      ),
      hasValue: (item, valueId) => listPlaceRefs(item).includes(valueId),
    }))
    .toSorted((a, b) => a.caption.localeCompare(b.caption, "en") || compareText(a.id, b.id));
};
