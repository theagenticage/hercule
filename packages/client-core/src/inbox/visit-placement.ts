/**
 * What the Inbox page holds in place for the length of a visit. Nothing on
 * the page moves unless the user moves it, so a read that arrives mid-visit
 * may change what a card says (its words, status, progress) but not where it
 * lies. A visit holds, for each card:
 *
 * - its side (a card that gets a Task keeps its column);
 * - the lead it rides on, if any (a read that says a card now rides on a
 *   ticket does not move it out of Requests, and one that says it no longer
 *   does not take it from under the ticket);
 * - its row: the order of the cards inside each list, which is the order they
 *   joined the visit in;
 * - on the wide side, the surfaces it lies on and which of them draws it in
 *   full, and the order of the surfaces;
 * - in Requests, the group it lies in, and the order of the groups.
 *
 * A card new to the visit is placed as the read says. It joins the end of its
 * list, and its surface or group, if it is new too, joins at the end. The
 * user's own Group by or Requests order starts the surfaces or groups over, and
 * so does the next visit. The user's own Link and Unlink are the one thing that
 * changes what a card rides on during a visit (`RidingChoices`). The order of
 * the rows inside a list is held until the next visit even then: the user asked
 * for other lists, not for other rows.
 */
import type { Inbox, InboxCard, InboxSide } from "@hercule/contract";
import { PLACE_GROUPING, resolveGrouping, type InboxGrouping } from "./groupings";
import {
  compareSurfaceHeads,
  findHomeName,
  findSurfaceHeads,
  type PlaceContext,
  type SurfaceHead,
} from "./inbox-place";
import { readChosenLead, type RidingChoices } from "./riding-choices";

/** How the Requests column is ordered. */
export type RequestsOrder = "oldest" | "mine" | "place";

/** The group label of a request that lies under no place. */
const ELSEWHERE = "Elsewhere";

/** The group keys of "yours first": they sort in the order the halves are drawn. */
const YOURS_KEY = "0";
const OTHERS_KEY = "1";

/** The user's choices that decide where cards lie. */
export interface PlacementChoice {
  /** The Group by choice: `HOME_GROUPING`, `STATUS_GROUPING` or the word of a kind of place. */
  readonly grouping: string;
  readonly requestsOrder: RequestsOrder;
}

/** What a visit holds of one card. */
export interface HeldCard {
  /** The side the card was first seen on. */
  readonly side: InboxSide;
  /**
   * The ref of the lead the card rode on when it was first seen, or where the
   * user last put it. `undefined` for a card that rides on nothing. A card
   * rides only while that lead is a card of the page, so a dismissed lead sets
   * it free and the lead's return takes it back.
   */
  readonly ridesOn: string | undefined;
  /**
   * The position of the card in the order the cards joined the visit, for
   * every list it can lie in. A card that is gone from the reads keeps its
   * position, so one the user dismissed and undid lies where it did.
   */
  readonly rank: number;
  /**
   * Ongoing cards: the heads of the surfaces the card lies on, as they were
   * first seen. The first is where the card is drawn in full. A head that is a
   * place is read again from each reply, so its words stay current. Unset
   * until the card is placed, and again after the user groups differently.
   */
  readonly heads: readonly SurfaceHead[] | undefined;
  /**
   * Requests: the key of the group the card lies in. It is the label when
   * ordered by place. Unset until the card is placed, and again after the user
   * orders the requests differently.
   */
  readonly requestGroup: string | undefined;
}

/** What a visit holds of where cards lie. Build it with `placeInboxCards`. */
export interface VisitPlacement {
  /** Every card the visit has placed, by card id. */
  readonly cards: ReadonlyMap<string, HeldCard>;
  /**
   * The Group by choice the surfaces below were held for, as the user made it,
   * or `undefined` before the visit has placed anything. A new read does not
   * place the surfaces again for the same choice, even when the replies no
   * longer offer that grouping.
   */
  readonly requestedGrouping: string | undefined;
  /**
   * The grouping the surfaces below were placed with, by its id and the name
   * the Group by menu gave it: `requestedGrouping`, or Place when the first
   * reply did not offer it. The name is held with it, so the menu can keep a
   * row for a grouping that later replies stop offering.
   */
  readonly grouping: InboxGrouping;
  /** The position of each surface, by head id, in the order the surfaces joined the visit. */
  readonly surfaceRank: ReadonlyMap<string, number>;
  /** The Requests order the groups below were held for. */
  readonly requestsOrder: RequestsOrder;
  /** The position of each group, by key, in the order the groups joined the visit. */
  readonly groupRank: ReadonlyMap<string, number>;
}

/** A visit that holds nothing yet. */
export const NO_PLACEMENT: VisitPlacement = {
  cards: new Map(),
  requestedGrouping: undefined,
  grouping: PLACE_GROUPING,
  surfaceRank: new Map(),
  requestsOrder: "oldest",
  groupRank: new Map(),
};

/** Compares the keys of two request groups: the halves of "yours first" in order, places by name, and "Elsewhere" last. */
const compareGroupKeys = (a: string, b: string): number =>
  a === b ? 0 : a === ELSEWHERE ? 1 : b === ELSEWHERE ? -1 : a.localeCompare(b, "en");

/** Sorts oldest first by when the card was first observed, then by id, so the order never depends on activity. */
const compareOldestFirst = (a: InboxCard, b: InboxCard): number =>
  Date.parse(a.firstObservedAt) - Date.parse(b.firstObservedAt) || a.id.localeCompare(b.id, "en");

/** Returns the key of the group a request lies in for `order`. */
const decideGroupKey = (card: InboxCard, order: RequestsOrder, context: PlaceContext): string => {
  if (order === "oldest") return "";
  if (order === "mine") return card.yours ? YOURS_KEY : OTHERS_KEY;
  return findHomeName(card, context) ?? ELSEWHERE;
};

/**
 * Returns `ranks` with `added` appended in the order `compare` gives, each
 * behind every key already ranked. Returns `ranks` itself when `added` is empty.
 */
const appendRanks = <Key extends string>(
  ranks: ReadonlyMap<string, number>,
  added: readonly Key[],
  compare: (a: Key, b: Key) => number,
): ReadonlyMap<string, number> => {
  if (added.length === 0) return ranks;
  const next = new Map(ranks);
  for (const key of added.toSorted(compare)) next.set(key, next.size);
  return next;
};

/**
 * Returns what the visit holds once it has seen `inbox`, given `held` from the
 * reads before it. Returns `held` itself when `inbox` adds nothing to it, so
 * a caller can tell by identity whether anything changed.
 *
 * - A card not seen before is placed as `inbox` says, and takes the last
 *   position in the order of the visit; cards that join together take it
 *   oldest first. A card seen before keeps its side, its surfaces, its group
 *   and its position, whatever `inbox` now says. A card that is gone from
 *   `inbox` keeps its entry, so one the user dismissed and undid lies where it
 *   did.
 * - A surface or a group not seen before joins at the end, behind the others.
 *   Several that join together are put in the page's usual order.
 * - A different Group by (`choice.grouping`) or Requests order drops the
 *   surfaces or groups held for the old one, and places every card again. The
 *   Group by is resolved against what `inbox` offers only then, once, and the
 *   result is held with the choice, so a kind of place that leaves the replies
 *   later does not move cards. Sides and positions are never dropped.
 * - What a card rides on is held like its side. `riding` is the one thing that
 *   changes it: the user's own Link or Unlink.
 */
export const placeInboxCards = (
  inbox: Inbox,
  choice: PlacementChoice,
  held: VisitPlacement,
  context: PlaceContext,
  riding: RidingChoices,
): VisitPlacement => {
  const keepsSurfaces = held.requestedGrouping === choice.grouping;
  const grouping = keepsSurfaces ? held.grouping : resolveGrouping(inbox, choice.grouping);
  const keepsGroups = held.requestsOrder === choice.requestsOrder;
  const oldestFirst = [...inbox.cards].sort(compareOldestFirst);

  // A card keeps its side and position always; its surfaces and its group only for the same choice.
  const cards = new Map<string, HeldCard>();
  let isChanged = !keepsSurfaces || !keepsGroups;
  for (const [id, card] of held.cards) {
    const chosen = riding.get(id);
    const ridesOn = chosen === undefined ? card.ridesOn : readChosenLead(chosen);
    if (ridesOn !== card.ridesOn) isChanged = true;
    cards.set(id, {
      side: card.side,
      ridesOn,
      rank: card.rank,
      heads: keepsSurfaces ? card.heads : undefined,
      requestGroup: keepsGroups ? card.requestGroup : undefined,
    });
  }
  const newHeads = new Map<string, SurfaceHead>();
  const newGroups = new Set<string>();

  for (const card of oldestFirst) {
    const seen = cards.get(card.id);
    if (seen === undefined) isChanged = true;
    const side = seen?.side ?? card.side;
    let heads = seen?.heads;
    let requestGroup = seen?.requestGroup;
    if (side === "ongoing" && heads === undefined) {
      heads = findSurfaceHeads(card, context, grouping.id);
      for (const head of heads) {
        if (!(keepsSurfaces && held.surfaceRank.has(head.id))) newHeads.set(head.id, head);
      }
      isChanged = true;
    }
    if (side === "requests" && requestGroup === undefined) {
      requestGroup = decideGroupKey(card, choice.requestsOrder, context);
      if (!(keepsGroups && held.groupRank.has(requestGroup))) newGroups.add(requestGroup);
      isChanged = true;
    }
    const chosen = riding.get(card.id);
    const ridesOn =
      seen !== undefined
        ? seen.ridesOn
        : chosen === undefined
          ? card.ridesOn
          : readChosenLead(chosen);
    cards.set(card.id, { side, ridesOn, rank: seen?.rank ?? cards.size, heads, requestGroup });
  }
  if (!isChanged) return held;

  return {
    cards,
    requestedGrouping: choice.grouping,
    grouping,
    surfaceRank: appendRanks(
      keepsSurfaces ? held.surfaceRank : new Map(),
      [...newHeads.keys()],
      (a, b) => compareSurfaceHeads(newHeads.get(a)!, newHeads.get(b)!),
    ),
    requestsOrder: choice.requestsOrder,
    groupRank: appendRanks(
      keepsGroups ? held.groupRank : new Map(),
      [...newGroups],
      compareGroupKeys,
    ),
  };
};
