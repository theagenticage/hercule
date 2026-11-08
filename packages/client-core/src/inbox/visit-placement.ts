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
 * changes what a card rides on during a visit, and the placement is where that
 * is decided too: it holds the moves the controller has not answered yet
 * (`pendingMoves`) and the steps that answer them (`startRidingMove`,
 * `settleRidingMove`, `refuseRidingMove`). The order of the rows inside a list
 * is held until the next visit even then: the user asked for other lists, not
 * for other rows.
 */
import type { EntityUnlinkResult, Inbox, InboxCard, InboxSide } from "@hercule/contract";
import { PLACE_GROUPING, resolveGrouping, type InboxGrouping } from "./groupings";
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

/** What a visit holds of one card. */
export interface HeldCard {
  /** The side the card was first seen on. */
  readonly side: InboxSide;
  /**
   * The ref of the lead the card rode on when it was first seen, or where the
   * last answered Link or Unlink of the user left it. `undefined` for a card
   * that rides on nothing. The moves still waiting for an answer are not in it
   * (`VisitPlacement.pendingMoves`; `readRidesOn` adds them). A card rides only
   * while that lead is a card of the page, so a dismissed lead sets it free and
   * the lead's return takes it back.
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

/**
 * What a Link or Unlink does to the card that can ride on one end of the pair
 * (a request) and the lead at the other end (a card of lasting work).
 *
 * - A link puts the card on `leadRef` when it rode on nothing. A card that
 *   rides on another lead keeps it.
 * - An unlink takes the card off `leadRef` when it rode on that lead. A card
 *   that rides on another lead keeps it.
 */
export interface RidingMove {
  readonly direction: "link" | "unlink";
  readonly cardId: string;
  readonly leadRef: string;
}

/** A `RidingMove` the controller has not answered yet. */
export interface PendingRidingMove extends RidingMove {
  /** Names the user's gesture, so its answer can find the move. */
  readonly gesture: number;
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
  /**
   * The Links and Unlinks the user made that the controller has not answered,
   * in the order they were made. They show on the page at once, but they are
   * never written into `HeldCard.ridesOn`: the card's place is worked out from
   * the settled place and these moves each time (`readRidesOn`). That is why a
   * refused move can be dropped without undoing a move made after it.
   */
  readonly pendingMoves: readonly PendingRidingMove[];
}

/** A visit that holds nothing yet. */
export const NO_PLACEMENT: VisitPlacement = {
  cards: new Map(),
  requestedGrouping: undefined,
  grouping: PLACE_GROUPING,
  surfaceRank: new Map(),
  requestsOrder: "oldest",
  groupRank: new Map(),
  pendingMoves: [],
};

/** Checks whether the visit has placed a read yet, which is when it starts to hold cards in place. */
export const hasPlacedCards = (placement: VisitPlacement): boolean =>
  placement.requestedGrouping !== undefined;

/** Returns the ref of the lead a card rides on after `move`, given the ref it rode on before. */
const playRidingMove = (ridesOn: string | undefined, move: RidingMove): string | undefined => {
  if (move.direction === "link") return ridesOn ?? move.leadRef;
  return ridesOn === move.leadRef ? undefined : ridesOn;
};

/**
 * Returns the ref of the lead `card` is drawn riding on, or `undefined` when
 * it stands alone: the place the visit holds, with the pending moves played in
 * the order they were made. A card the visit has not placed yet rides as its
 * read says. Link and Unlink are planned from this place, because a later read
 * may say otherwise while a move waits for the controller's answer.
 */
export const readRidesOn = (placement: VisitPlacement, card: InboxCard): string | undefined => {
  const held = placement.cards.get(card.id);
  let ridesOn = held === undefined ? card.ridesOn : held.ridesOn;
  for (const move of placement.pendingMoves) {
    if (move.cardId === card.id) ridesOn = playRidingMove(ridesOn, move);
  }
  return ridesOn;
};

/** Returns `placement` with `move` waiting for the controller's answer, as part of `gesture`. */
export const startRidingMove = (
  placement: VisitPlacement,
  gesture: number,
  move: RidingMove,
): VisitPlacement => ({
  ...placement,
  pendingMoves: [...placement.pendingMoves, { ...move, gesture }],
});

/**
 * Returns `placement` once the controller has answered `gesture`, or
 * `placement` itself when `gesture` has no move waiting. The move is played on
 * the settled place of its card and leaves the pending moves. The exception is
 * an unlink whose answer says a claim of a source still joins the pair
 * (`remaining`): the card still rides, so its place stays. A move that waits
 * behind it is not touched.
 */
export const settleRidingMove = (
  placement: VisitPlacement,
  gesture: number,
  remaining: EntityUnlinkResult["remaining"],
): VisitPlacement => {
  const answered = placement.pendingMoves.find((move) => move.gesture === gesture);
  if (answered === undefined) return placement;
  const held = placement.cards.get(answered.cardId);
  const didChangeRiding = !(answered.direction === "unlink" && remaining === "source");
  const cards =
    held === undefined || !didChangeRiding
      ? placement.cards
      : new Map(placement.cards).set(answered.cardId, {
          ...held,
          ridesOn: playRidingMove(held.ridesOn, answered),
        });
  return {
    ...placement,
    cards,
    pendingMoves: placement.pendingMoves.filter((move) => move !== answered),
  };
};

/**
 * Returns `placement` once the controller has refused `gesture`, or
 * `placement` itself when `gesture` has no move waiting. The move is dropped
 * and the card stays where its settled place and the moves made after the
 * refused one put it.
 */
export const refuseRidingMove = (placement: VisitPlacement, gesture: number): VisitPlacement => {
  const kept = placement.pendingMoves.filter((move) => move.gesture !== gesture);
  return kept.length === placement.pendingMoves.length
    ? placement
    : { ...placement, pendingMoves: kept };
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
 * - What a card rides on is held like its side. Only an answered Link or
 *   Unlink of the user changes it (`settleRidingMove`). `held.pendingMoves`
 *   are carried over as they are.
 */
export const placeInboxCards = (
  inbox: Inbox,
  choice: PlacementChoice,
  held: VisitPlacement,
  context: PlaceContext,
): VisitPlacement => {
  const keepsSurfaces = held.requestedGrouping === choice.grouping;
  const grouping = keepsSurfaces ? held.grouping : resolveGrouping(inbox, choice.grouping);
  const keepsGroups = held.requestsOrder === choice.requestsOrder;
  const oldestFirst = [...inbox.cards].sort(compareOldestFirst);

  // A card keeps its side and position always; its surfaces and its group only for the same choice.
  const cards = new Map<string, HeldCard>();
  let isChanged = !keepsSurfaces || !keepsGroups;
  for (const [id, card] of held.cards) {
    cards.set(id, {
      side: card.side,
      ridesOn: card.ridesOn,
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
    const ridesOn = seen === undefined ? card.ridesOn : seen.ridesOn;
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
    pendingMoves: held.pendingMoves,
  };
};
