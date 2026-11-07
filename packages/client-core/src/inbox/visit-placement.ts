/**
 * What the Inbox page holds in place for the length of a visit. Nothing on
 * the page moves unless the user moves it, so a read that arrives mid-visit
 * may change what a card says (its words, status, progress) but not where it
 * lies. A visit holds, for each card:
 *
 * - its side (a card that gets a Task keeps its column);
 * - on the wide side, the surfaces it lies on and which of them draws it in
 *   full, and the order of the surfaces;
 * - in Requests, the group it lies in, and the order of the groups.
 *
 * A card new to the visit is placed as the read says and its surface or group,
 * if it is new too, joins at the end. The user's own Group by or Requests order
 * starts that part over, and so does the next visit.
 */
import type { Inbox, InboxCard, InboxSide } from "@hercule/contract";
import { resolveGrouping } from "./groupings";
import {
  compareSurfaceHeads,
  findHomeName,
  findSurfaceHeads,
  type PlaceContext,
  type SurfaceHead,
} from "./inbox-place";

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

/** What a visit holds of where cards lie. Build it with `placeInboxCards`. */
export interface VisitPlacement {
  /** The side each card was first seen on, by card id. */
  readonly sides: ReadonlyMap<string, InboxSide>;
  /** The grouping the surfaces below were held for. */
  readonly grouping: string;
  /**
   * The heads of the surfaces each ongoing card lies on, by card id, as they
   * were first seen. The first is where the card is drawn in full. A head that
   * is a place is read again from each reply, so its words stay current.
   */
  readonly headsOfCard: ReadonlyMap<string, readonly SurfaceHead[]>;
  /** The position of each surface, by head id, in the order the surfaces joined the visit. */
  readonly surfaceRank: ReadonlyMap<string, number>;
  /** The Requests order the groups below were held for. */
  readonly requestsOrder: RequestsOrder;
  /** The key of the group each request lies in, by card id. It is the label when ordered by place. */
  readonly groupOfCard: ReadonlyMap<string, string>;
  /** The position of each group, by key, in the order the groups joined the visit. */
  readonly groupRank: ReadonlyMap<string, number>;
}

/** A visit that holds nothing yet. */
export const NO_PLACEMENT: VisitPlacement = {
  sides: new Map(),
  grouping: "",
  headsOfCard: new Map(),
  surfaceRank: new Map(),
  requestsOrder: "oldest",
  groupOfCard: new Map(),
  groupRank: new Map(),
};

/** Compares the keys of two request groups: the halves of "yours first" in order, places by name, and "Elsewhere" last. */
const compareGroupKeys = (a: string, b: string): number =>
  a === b ? 0 : a === ELSEWHERE ? 1 : b === ELSEWHERE ? -1 : a.localeCompare(b, "en");

/** Sorts oldest first by when the card was first observed, then by id, so the order never depends on activity. */
export const compareOldestFirst = (a: InboxCard, b: InboxCard): number =>
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
 * - A card not seen before is placed as `inbox` says. A card seen before keeps
 *   its side, its surfaces and its group, whatever `inbox` now says. A card
 *   that is gone from `inbox` keeps its entry, so one the user dismissed and
 *   undid lies where it did.
 * - A surface or a group not seen before joins at the end, behind the others.
 *   Several that join together are put in the page's usual order.
 * - A different Group by (`choice.grouping`, once it is resolved against what
 *   `inbox` offers) or Requests order drops what was held for the old one, and
 *   places every card again. Sides are never dropped.
 */
export const placeInboxCards = (
  inbox: Inbox,
  choice: PlacementChoice,
  held: VisitPlacement,
  context: PlaceContext,
): VisitPlacement => {
  const grouping = resolveGrouping(inbox, choice.grouping);
  const keepsSurfaces = held.grouping === grouping;
  const keepsGroups = held.requestsOrder === choice.requestsOrder;
  const oldestFirst = [...inbox.cards].sort(compareOldestFirst);

  const sides = new Map(held.sides);
  const headsOfCard = new Map(keepsSurfaces ? held.headsOfCard : []);
  const groupOfCard = new Map(keepsGroups ? held.groupOfCard : []);
  const newHeads = new Map<string, SurfaceHead>();
  const newGroups = new Set<string>();
  let isChanged = !keepsSurfaces || !keepsGroups;

  for (const card of oldestFirst) {
    if (!sides.has(card.id)) {
      sides.set(card.id, card.side);
      isChanged = true;
    }
    const side = sides.get(card.id);
    if (side === "ongoing" && !headsOfCard.has(card.id)) {
      const heads = findSurfaceHeads(card, context, grouping);
      headsOfCard.set(card.id, heads);
      for (const head of heads) {
        if (!(keepsSurfaces && held.surfaceRank.has(head.id))) newHeads.set(head.id, head);
      }
      isChanged = true;
    }
    if (side === "requests" && !groupOfCard.has(card.id)) {
      const key = decideGroupKey(card, choice.requestsOrder, context);
      groupOfCard.set(card.id, key);
      if (!(keepsGroups && held.groupRank.has(key))) newGroups.add(key);
      isChanged = true;
    }
  }
  if (!isChanged) return held;

  return {
    sides,
    grouping,
    headsOfCard,
    surfaceRank: appendRanks(
      keepsSurfaces ? held.surfaceRank : new Map(),
      [...newHeads.keys()],
      (a, b) => compareSurfaceHeads(newHeads.get(a)!, newHeads.get(b)!),
    ),
    requestsOrder: choice.requestsOrder,
    groupOfCard,
    groupRank: appendRanks(
      keepsGroups ? held.groupRank : new Map(),
      [...newGroups],
      compareGroupKeys,
    ),
  };
};
