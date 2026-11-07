/**
 * The facets of the Inbox's Filter menu, built on the shared filter of
 * `@hercule/client-core/desk`: whose it is, then every place on the page, one
 * facet for each kind of place.
 */
import type { Inbox, InboxCard } from "@hercule/contract";
import type { FilterFacet } from "../desk/filter";

/** The id of the facet for whose a card is. */
export const WHOSE_FACET_ID = "whose";

const MINE = "mine";
const OTHERS = "others";

const buildWhoseFacet = (): FilterFacet<InboxCard> => ({
  id: WHOSE_FACET_ID,
  caption: "",
  values: [
    { id: MINE, name: "Mine" },
    { id: OTHERS, name: "Other people's" },
  ],
  hasValue: (card, valueId) => (valueId === MINE ? card.yours : !card.yours),
});

/**
 * Returns the facets of the Filter menu, in menu order. The places are those
 * above the cards of the whole Inbox, so a place a filter hides stays in the
 * menu to be chosen again. A kind of place gets a facet named for its caption
 * (or its noun), and its places are listed by title. A card has a place's
 * value when the place is anywhere above it, not only directly. A restricted
 * place has no title and is not listed. A work item that is itself a card is
 * not a place to filter by.
 */
export const buildInboxFacets = (inbox: Inbox): readonly FilterFacet<InboxCard>[] => {
  const cardRefs = new Set(inbox.cards.map((card) => card.ref));
  const aboveCards = new Set(inbox.cards.flatMap((card) => card.ancestors));
  const kinds = new Map<string, { caption: string; values: { id: string; name: string }[] }>();
  for (const place of inbox.places) {
    if (place.title === undefined || !aboveCards.has(place.ref) || cardRefs.has(place.ref))
      continue;
    const kind = kinds.get(place.kind) ?? { caption: place.caption ?? place.noun, values: [] };
    kind.values.push({ id: place.ref, name: place.title });
    kinds.set(place.kind, kind);
  }
  const placeFacets = [...kinds].map(([kind, { caption, values }]): FilterFacet<InboxCard> => ({
    id: kind,
    caption,
    values: values.sort((a, b) => a.name.localeCompare(b.name, "en")),
    hasValue: (card, valueId) => card.ancestors.includes(valueId),
  }));
  return [
    buildWhoseFacet(),
    ...placeFacets.sort((a, b) => a.caption.localeCompare(b.caption, "en")),
  ];
};
