/** The ways the wide side of the Inbox can be grouped, for the Group by menu. */
import type { Inbox } from "@hercule/contract";
import { HOME_GROUPING, STATUS_GROUPING } from "./inbox-place";

/** One row of the Group by menu. `id` is what `InboxView.grouping` holds. */
export interface InboxGrouping {
  readonly id: string;
  readonly name: string;
}

/**
 * Returns the rows of the Group by menu, in order:
 *
 * - Place, the usual home of each kind;
 * - each kind of place above the lasting work, by its caption, such as
 *   "Linear project", ordered by caption. A kind is offered as soon as one
 *   lasting-work card lies under a place of that kind; the cards under none
 *   get a surface "No <caption>". A work item that is itself a card is not a
 *   level;
 * - Status.
 *
 * The rows are those of the whole Inbox, never of what a filter leaves, so a
 * grouping does not vanish from the menu because of a filter.
 */
export const listInboxGroupings = (inbox: Inbox): readonly InboxGrouping[] => {
  const cardRefs = new Set(inbox.cards.map((card) => card.ref));
  const placeByRef = new Map(inbox.places.map((place) => [place.ref, place]));
  const captionOfKind = new Map<string, string>();
  for (const card of inbox.cards) {
    if (card.card !== "rich") continue;
    for (const ref of card.ancestors) {
      const place = placeByRef.get(ref);
      if (place?.caption !== undefined && !cardRefs.has(ref)) {
        captionOfKind.set(place.kind, place.caption);
      }
    }
  }
  const levels = [...captionOfKind]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  return [{ id: HOME_GROUPING, name: "Place" }, ...levels, { id: STATUS_GROUPING, name: "Status" }];
};

/**
 * Returns `requested` when the Group by menu of `inbox` offers it, and
 * `HOME_GROUPING` when it does not: the kind of place the user grouped by may
 * have left the Inbox.
 */
export const resolveGrouping = (inbox: Inbox, requested: string): string =>
  listInboxGroupings(inbox).some((offered) => offered.id === requested) ? requested : HOME_GROUPING;
