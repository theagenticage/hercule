/**
 * How the keys move through the Inbox page, and which card the page moves on
 * to after a move. Both work on the cards in the order the page draws them
 * (the wide side first, then the narrow column), so the order is read from
 * the screen once and the decisions stay pure.
 */

/** Which part of the page a card lies in: the wide side (Ongoing) or the narrow column (Requests). */
export type PageColumn = "wide" | "narrow";

/** One card on the page, as the keys see it. */
export interface InboxStop {
  readonly id: string;
  readonly column: PageColumn;
  /** The card's vertical middle in pixels, from any fixed origin on the page. Left and right use it to cross at the nearest height. */
  readonly middle: number;
  /** True when the card still waits for the user: it has no live Task. */
  readonly waits: boolean;
}

/**
 * The ways a key walks:
 *
 * - `up` and `down` stay in the card's column.
 * - `left` and `right` cross to the other column at the nearest height.
 * - `next` and `previous` read through the whole page in its order.
 */
export type InboxWalk = "up" | "down" | "left" | "right" | "next" | "previous";

/** The card a walk left, and the walk it took. The opposite walk comes straight back to it. */
export interface WalkedFrom {
  readonly id: string;
  readonly walk: InboxWalk;
}

const OPPOSITE: Readonly<Record<InboxWalk, InboxWalk>> = {
  up: "down",
  down: "up",
  left: "right",
  right: "left",
  next: "previous",
  previous: "next",
};

/**
 * Returns the id of the card a walk from `current` reaches, or `undefined`
 * when there is nowhere to go (the end of the column, no column on that side,
 * or no card at all).
 *
 * - With no current card, or one that is not on the page, every walk lands on
 *   the first card.
 * - The walk that is the opposite of `cameFrom.walk` returns to the card it
 *   came from, if that card is still on the page. Without this, left and
 *   right would not undo each other when the cards on the two sides do not
 *   line up.
 * - `left` goes only from the narrow column to the wide side, and `right` only
 *   the other way. The card reached is the one whose middle is nearest the
 *   current card's middle, and the earlier one when two are as near.
 */
export const walkInbox = (
  stops: readonly InboxStop[],
  current: string | undefined,
  walk: InboxWalk,
  cameFrom?: WalkedFrom,
): string | undefined => {
  const at = stops.findIndex((stop) => stop.id === current);
  const from = stops[at];
  if (from === undefined) return stops[0]?.id;
  if (
    cameFrom !== undefined &&
    cameFrom.walk === OPPOSITE[walk] &&
    stops.some((stop) => stop.id === cameFrom.id)
  ) {
    return cameFrom.id;
  }
  if (walk === "next") return stops[at + 1]?.id;
  if (walk === "previous") return stops[at - 1]?.id;
  if (walk === "up" || walk === "down") {
    const inColumn = stops.filter((stop) => stop.column === from.column);
    const index = inColumn.indexOf(from);
    return inColumn[walk === "down" ? index + 1 : index - 1]?.id;
  }
  const target: PageColumn = walk === "right" ? "narrow" : "wide";
  if (from.column === target) return undefined;
  let nearest: InboxStop | undefined;
  for (const stop of stops) {
    if (stop.column !== target) continue;
    if (
      nearest === undefined ||
      Math.abs(stop.middle - from.middle) < Math.abs(nearest.middle - from.middle)
    ) {
      nearest = stop;
    }
  }
  return nearest?.id;
};

/**
 * Returns the id of the card to move on to after a move on the card `id`, or
 * `undefined` when no other card in its column still waits.
 *
 * The cards after `id` come first, in page order, then the cards before it,
 * nearest first. The answer comes from the order of the page, never from what
 * lies under the pointer: while the page closes up after a move, that is a
 * moving target. Read the stops before the move, because a move can take the
 * card off the page.
 */
export const decideNextWaitingCard = (
  stops: readonly InboxStop[],
  id: string,
): string | undefined => {
  const at = stops.findIndex((stop) => stop.id === id);
  const from = stops[at];
  if (from === undefined) return undefined;
  const inColumn = stops.filter((stop) => stop.column === from.column);
  const index = inColumn.indexOf(from);
  const order = [...inColumn.slice(index + 1), ...inColumn.slice(0, index).reverse()];
  return order.find((stop) => stop.waits)?.id;
};
