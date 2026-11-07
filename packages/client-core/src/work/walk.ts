/**
 * Walking the board with the arrow keys, `[` and `]`. The walk is over what is
 * on screen, not over the stored cards: a card hidden behind "13 more", or in
 * a folded lane, is not on it.
 */

/** The ids of the cards one cell shows, top to bottom. */
export type ShownColumn = readonly string[];

/** One lane that is drawn: a column for each board stage, left to right. A folded lane has only empty columns. */
export interface ShownLane {
  readonly id: string;
  readonly isFolded: boolean;
  readonly columns: readonly ShownColumn[];
}

/** Every lane that is drawn, top to bottom. */
export type ShownBoard = readonly ShownLane[];

/** A step of the walk. */
export type BoardWalk = "up" | "down" | "left" | "right" | "previousLane" | "nextLane";

/**
 * A place the walk can stand on: a card, or the head of a folded lane, which
 * has no card to stand on.
 */
export type WalkStop =
  | { readonly kind: "card"; readonly cardId: string }
  | { readonly kind: "lane"; readonly laneId: string };

interface Spot {
  readonly lane: number;
  readonly column: number;
  readonly row: number;
}

const findSpot = (shown: ShownBoard, cardId: string): Spot | undefined => {
  for (const [lane, { columns }] of shown.entries()) {
    for (const [column, ids] of columns.entries()) {
      const row = ids.indexOf(cardId);
      if (row >= 0) return { lane, column, row };
    }
  }
  return undefined;
};

/** Returns the ids of every card on screen, lane by lane, column by column, top to bottom. */
export const listShownCardIds = (shown: ShownBoard): readonly string[] =>
  shown.flatMap(({ columns }) => columns.flat());

/**
 * Returns where a lane walk stops in `lane`: its head when it is folded, else
 * its first card (the top of its leftmost column that has one). An open lane
 * with no card is not a stop.
 */
const findLaneStop = (lane: ShownLane | undefined): WalkStop | undefined => {
  if (lane === undefined) return undefined;
  if (lane.isFolded) return { kind: "lane", laneId: lane.id };
  const cardId = lane.columns.find((ids) => ids.length > 0)?.[0];
  return cardId === undefined ? undefined : { kind: "card", cardId };
};

/**
 * Returns where a step of the walk goes to, or `undefined` when there is
 * nowhere to go and the focus stays.
 *
 * - `up` and `down` stay in the column. At the end of the column they cross
 *   into the nearest lane above or below that has a card in the same column.
 *   A folded lane has none, so they pass over it.
 * - `left` and `right` go to the nearest column of the same lane that has a
 *   card, skipping empty columns, at the same row or the last one of that
 *   column. They never leave the lane. Left and right choose the same row
 *   number, which is the card at the nearest height while the cards keep one
 *   height. A card that grows, for example with larger text spacing, can
 *   make the nearest height a different row; the walk does not measure.
 * - `previousLane` and `nextLane` go to the nearest lane above or below that
 *   has a stop: the first card of an open lane, or the head of a folded one.
 *
 * A `from` that is not on screen (or none at all) starts the walk at the
 * first card of the board, or at its first stop for a lane walk. A `from` that is the head of a folded lane starts
 * only a lane walk: the other steps have no card to go from there.
 */
export const walkBoard = (
  shown: ShownBoard,
  from: WalkStop | undefined,
  walk: BoardWalk,
): WalkStop | undefined => {
  const isLaneWalk = walk === "previousLane" || walk === "nextLane";
  const lane =
    from?.kind === "lane"
      ? shown.findIndex(({ id }) => id === from.laneId)
      : from === undefined
        ? -1
        : (findSpot(shown, from.cardId)?.lane ?? -1);
  if (lane < 0) {
    if (isLaneWalk) return shown.map(findLaneStop).find((stop) => stop !== undefined);
    const first = listShownCardIds(shown)[0];
    return first === undefined ? undefined : { kind: "card", cardId: first };
  }

  if (isLaneWalk) {
    const step = walk === "previousLane" ? -1 : 1;
    for (let other = lane + step; other >= 0 && other < shown.length; other += step) {
      const stop = findLaneStop(shown[other]);
      if (stop !== undefined) return stop;
    }
    return undefined;
  }
  if (from?.kind !== "card") return undefined;
  const { column, row } = findSpot(shown, from.cardId)!;

  if (walk === "up" || walk === "down") {
    const here = shown[lane]?.columns[column];
    const sibling = here?.[walk === "up" ? row - 1 : row + 1];
    if (sibling !== undefined) return { kind: "card", cardId: sibling };
    const step = walk === "up" ? -1 : 1;
    for (let other = lane + step; other >= 0 && other < shown.length; other += step) {
      const ids = shown[other]?.columns[column];
      const cardId = walk === "up" ? ids?.at(-1) : ids?.[0];
      if (cardId !== undefined) return { kind: "card", cardId };
    }
    return undefined;
  }

  const columns = shown[lane]?.columns ?? [];
  const step = walk === "left" ? -1 : 1;
  for (let other = column + step; other >= 0 && other < columns.length; other += step) {
    const ids = columns[other];
    const cardId = ids?.[Math.min(row, ids.length - 1)];
    if (cardId !== undefined) return { kind: "card", cardId };
  }
  return undefined;
};
