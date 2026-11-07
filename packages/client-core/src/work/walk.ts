/**
 * Walking the board with the arrow keys, `[` and `]`. The walk is over what is
 * on screen, not over the stored cards: a card hidden behind "13 more", or in
 * a folded lane, is not on it.
 */

/** The ids of the cards one cell shows, top to bottom. */
export type ShownColumn = readonly string[];

/** One lane: a column for each board stage, left to right. A folded lane has only empty columns. */
export type ShownLane = readonly ShownColumn[];

/** Every lane that is drawn, top to bottom. */
export type ShownBoard = readonly ShownLane[];

/** A step of the walk. */
export type BoardWalk = "up" | "down" | "left" | "right" | "previousLane" | "nextLane";

interface Spot {
  readonly lane: number;
  readonly column: number;
  readonly row: number;
}

const findSpot = (shown: ShownBoard, cardId: string): Spot | undefined => {
  for (const [lane, columns] of shown.entries()) {
    for (const [column, ids] of columns.entries()) {
      const row = ids.indexOf(cardId);
      if (row >= 0) return { lane, column, row };
    }
  }
  return undefined;
};

/** Returns the first card of a lane: the top of its leftmost column that has one. */
const findFirstCard = (lane: ShownLane | undefined): string | undefined =>
  lane?.find((ids) => ids.length > 0)?.[0];

/**
 * Returns the card that a step of the walk goes to, or `undefined` when there
 * is nowhere to go and the focus stays.
 *
 * - `up` and `down` stay in the column. At the end of the column they cross
 *   into the nearest lane above or below that has a card in the same column.
 * - `left` and `right` go to the nearest column of the same lane that has a
 *   card, skipping empty columns, at the same row or the last one of that
 *   column. They never leave the lane.
 * - `previousLane` and `nextLane` go to the first card of the nearest lane
 *   above or below that has a card.
 *
 * A `from` that is not on screen (or none at all) starts the walk at the first
 * card of the board.
 */
export const walkBoard = (
  shown: ShownBoard,
  from: string | undefined,
  walk: BoardWalk,
): string | undefined => {
  const spot = from === undefined ? undefined : findSpot(shown, from);
  if (spot === undefined) return shown.map(findFirstCard).find((id) => id !== undefined);
  const { lane, column, row } = spot;

  if (walk === "up" || walk === "down") {
    const here = shown[lane]?.[column];
    const sibling = here?.[walk === "up" ? row - 1 : row + 1];
    if (sibling !== undefined) return sibling;
    const step = walk === "up" ? -1 : 1;
    for (let other = lane + step; other >= 0 && other < shown.length; other += step) {
      const ids = shown[other]?.[column];
      if (ids !== undefined && ids.length > 0) return walk === "up" ? ids.at(-1) : ids[0];
    }
    return undefined;
  }

  if (walk === "left" || walk === "right") {
    const columns = shown[lane] ?? [];
    const step = walk === "left" ? -1 : 1;
    for (let other = column + step; other >= 0 && other < columns.length; other += step) {
      const ids = columns[other];
      if (ids !== undefined && ids.length > 0) return ids[Math.min(row, ids.length - 1)];
    }
    return undefined;
  }

  const step = walk === "previousLane" ? -1 : 1;
  for (let other = lane + step; other >= 0 && other < shown.length; other += step) {
    const first = findFirstCard(shown[other]);
    if (first !== undefined) return first;
  }
  return undefined;
};
