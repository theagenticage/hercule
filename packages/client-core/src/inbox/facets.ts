/**
 * The facets of the Inbox's Filter menu, built on the shared filter of
 * `@hercule/client-core/desk`: whose it is, then every place on the page, one
 * facet for each kind of place.
 */
import type { Inbox, InboxCard } from "@hercule/contract";
import type { FilterFacet } from "../desk/filter";
import { buildPlaceFacets } from "../desk/place-facets";

/** The id of the facet for whose a card is. */
const WHOSE_FACET_ID = "whose";

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
  return [
    buildWhoseFacet(),
    ...buildPlaceFacets(
      inbox.places.filter((place) => aboveCards.has(place.ref) && !cardRefs.has(place.ref)),
      (card: InboxCard) => card.ancestors,
    ),
  ];
};
