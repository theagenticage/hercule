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

/**
 * Returns the rows of `offered` with `held` among them, in its place by
 * caption. The page stays grouped by a kind of place for the whole visit,
 * also after a read stops offering it, so the menu keeps showing it. Returns
 * `offered` when `held` is `undefined` or already in it.
 */
export const keepHeldGrouping = (
  offered: readonly InboxGrouping[],
  held: InboxGrouping | undefined,
): readonly InboxGrouping[] => {
  if (held === undefined || offered.some((each) => each.id === held.id)) return offered;
  const levels = offered.filter((each) => each.id !== HOME_GROUPING && each.id !== STATUS_GROUPING);
  return [
    { id: HOME_GROUPING, name: "Place" },
    ...[...levels, held].sort((a, b) => a.name.localeCompare(b.name, "en")),
    { id: STATUS_GROUPING, name: "Status" },
  ];
};
