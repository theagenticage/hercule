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
 *   "Linear project". Only a kind that more than half of the rows lie under is
 *   offered, because a level that most rows have nothing to do with would only
 *   say "No ...". A work item that is itself a card is not a level;
 * - Status.
 *
 * The rows are those of the whole Inbox, never of what a filter leaves, so a
 * grouping does not vanish from the menu because of a filter.
 */
export const listInboxGroupings = (inbox: Inbox): readonly InboxGrouping[] => {
  const cardRefs = new Set(inbox.cards.map((card) => card.ref));
  const placeByRef = new Map(inbox.places.map((place) => [place.ref, place]));
  const richCards = inbox.cards.filter((card) => card.card === "rich");
  const rowsUnder = new Map<string, { name: string; rows: number }>();
  for (const card of richCards) {
    const kindsOfCard = new Map<string, string>();
    for (const ref of card.ancestors) {
      const place = placeByRef.get(ref);
      if (place?.caption !== undefined && !cardRefs.has(ref)) {
        kindsOfCard.set(place.kind, place.caption);
      }
    }
    for (const [kind, name] of kindsOfCard) {
      rowsUnder.set(kind, { name, rows: (rowsUnder.get(kind)?.rows ?? 0) + 1 });
    }
  }
  const levels = [...rowsUnder]
    .filter(([, level]) => level.rows * 2 > richCards.length)
    .map(([id, level]) => ({ id, name: level.name }))
    .sort((a, b) => a.name.localeCompare(b.name, "en"));
  return [{ id: HOME_GROUPING, name: "Place" }, ...levels, { id: STATUS_GROUPING, name: "Status" }];
};
