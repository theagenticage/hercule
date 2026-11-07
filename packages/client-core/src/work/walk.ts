/**
 * Walking the board with the arrow keys, `[` and `]`. The walk is over what is
 * on screen, not over the stored cards: a card hidden behind "13 more", or in
 * a folded lane, is not on it. Each lane has a column for each board stage,
 * left to right, and a folded lane has only empty columns.
 */
import type { WorkCard } from "@hercule/contract";
import type { ArrangedLane } from "./arrange-lanes";

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

/** Returns the cards one column of `lane` shows, top to bottom. A folded lane shows none. */
const readColumn = (lane: ArrangedLane, column: number): readonly WorkCard[] =>
  lane.isFolded ? [] : (lane.cells[column]?.arrangement.cards ?? []);

const findSpot = (lanes: readonly ArrangedLane[], cardId: string): Spot | undefined => {
  for (const [laneIndex, lane] of lanes.entries()) {
    for (const column of lane.cells.keys()) {
      const row = readColumn(lane, column).findIndex((card) => card.id === cardId);
      if (row >= 0) return { lane: laneIndex, column, row };
    }
  }
  return undefined;
};

/** Returns the ids of every card on screen, lane by lane, column by column, top to bottom. */
export const listShownCardIds = (lanes: readonly ArrangedLane[]): readonly string[] =>
  lanes.flatMap((lane) =>
    lane.cells.flatMap((_cell, column) => readColumn(lane, column).map((card) => card.id)),
  );

/**
 * Returns where a lane walk stops in `lane`: its head when it is folded, else
 * its first card (the top of its leftmost column that has one). An open lane
 * with no card on screen is not a stop.
 */
const findLaneStop = (lane: ArrangedLane | undefined): WalkStop | undefined => {
  if (lane === undefined) return undefined;
  if (lane.isFolded) return { kind: "lane", laneId: lane.lane.id };
  const cardId = lane.cells.find((cell) => cell.arrangement.cards.length > 0)?.arrangement.cards[0]
    ?.id;
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
  lanes: readonly ArrangedLane[],
  from: WalkStop | undefined,
  walk: BoardWalk,
): WalkStop | undefined => {
  const isLaneWalk = walk === "previousLane" || walk === "nextLane";
  const lane =
    from?.kind === "lane"
      ? lanes.findIndex((each) => each.lane.id === from.laneId)
      : from === undefined
        ? -1
        : (findSpot(lanes, from.cardId)?.lane ?? -1);
  if (lane < 0) {
    if (isLaneWalk) return lanes.map(findLaneStop).find((stop) => stop !== undefined);
    const first = listShownCardIds(lanes)[0];
    return first === undefined ? undefined : { kind: "card", cardId: first };
  }

  if (isLaneWalk) {
    const step = walk === "previousLane" ? -1 : 1;
    for (let other = lane + step; other >= 0 && other < lanes.length; other += step) {
      const stop = findLaneStop(lanes[other]);
      if (stop !== undefined) return stop;
    }
    return undefined;
  }
  if (from?.kind !== "card") return undefined;
  const { column, row } = findSpot(lanes, from.cardId)!;

  if (walk === "up" || walk === "down") {
    const here = readColumn(lanes[lane]!, column);
    const sibling = here[walk === "up" ? row - 1 : row + 1];
    if (sibling !== undefined) return { kind: "card", cardId: sibling.id };
    const step = walk === "up" ? -1 : 1;
    for (let other = lane + step; other >= 0 && other < lanes.length; other += step) {
      const cards = readColumn(lanes[other]!, column);
      const card = walk === "up" ? cards.at(-1) : cards[0];
      if (card !== undefined) return { kind: "card", cardId: card.id };
    }
    return undefined;
  }

  const here = lanes[lane]!;
  const step = walk === "left" ? -1 : 1;
  for (let other = column + step; other >= 0 && other < here.cells.length; other += step) {
    const cards = readColumn(here, other);
    const card = cards[Math.min(row, cards.length - 1)];
    if (card !== undefined) return { kind: "card", cardId: card.id };
  }
  return undefined;
};
