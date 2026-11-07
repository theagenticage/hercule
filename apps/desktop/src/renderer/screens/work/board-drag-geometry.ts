/**
 * Where a carried card would land, worked out from measurements of the board
 * taken once (at the lift, after each change of the slot, and after a scroll).
 * Nothing here reads the page, so the pointer's frame loop does no layout.
 *
 * All coordinates are in window pixels, as `getBoundingClientRect` gives them.
 */
import type { BoardStage } from "@hercule/contract";

/** Half the space between two columns: a pointer this close left of a column still counts as inside it. */
const HALF_COLUMN_GAP = 7;

/** The distance from the top edge of the board, in which a carried card scrolls the board up. */
const TOP_EDGE_ZONE = 130;

/** The distance from the bottom edge of the board, in which a carried card scrolls the board down. */
const BOTTOM_EDGE_ZONE = 70;

/** How many pixels the board scrolls per frame for each pixel the pointer is inside an edge zone, as a divisor. */
const EDGE_SCROLL_DIVISOR = 6;

/** The left edge of one stage's column. */
export interface StageColumn {
  readonly stage: BoardStage;
  readonly left: number;
}

/** A card standing in a cell: its id, the element, and the vertical middle of the place the layout gave it. */
export interface CellRow {
  readonly id: string;
  readonly element: HTMLElement;
  readonly middle: number;
}

/** One cell of an open lane, with the cards it shows, top to bottom. The card in the hand is not among them. */
export interface CellBox {
  readonly element: HTMLElement;
  readonly rows: readonly CellRow[];
}

/** One lane: its vertical extent, and its cells when it is open. */
export interface LaneBox {
  readonly id: string;
  readonly element: HTMLElement;
  readonly top: number;
  readonly bottom: number;
  readonly isFolded: boolean;
  /** The cells of an open lane, by stage. A folded lane has none. */
  readonly cells: ReadonlyMap<BoardStage, CellBox>;
}

/** Everything `chooseDropPlace` and `computeEdgeScrollSpeed` need. */
export interface BoardGeometry {
  readonly columns: readonly StageColumn[];
  readonly lanes: readonly LaneBox[];
  /** The top and bottom of the part of the board that is in view. */
  readonly viewTop: number;
  readonly viewBottom: number;
}

/**
 * Where a carried card would land:
 *
 * - `cell`: in an open lane at `stage`, as the card number `index` of the
 *   cards the cell shows (0 is the top), not counting the carried card.
 * - `folded-lane`: on a folded lane, which has no cells to put a slot in. The
 *   stage is the column the pointer is over, or `null` when the pointer is
 *   left of the columns, on the lane's head, which keeps the card's stage.
 */
export type DropPlace =
  | {
      readonly kind: "cell";
      readonly laneId: string;
      readonly stage: BoardStage;
      readonly index: number;
    }
  | { readonly kind: "folded-lane"; readonly laneId: string; readonly stage: BoardStage | null };

/** Returns whether two places are the same one. */
export const isSameDropPlace = (a: DropPlace | null, b: DropPlace | null): boolean => {
  if (a === null || b === null) return a === b;
  if (a.kind === "cell" && b.kind === "cell") {
    return a.laneId === b.laneId && a.stage === b.stage && a.index === b.index;
  }
  return (
    a.kind === "folded-lane" &&
    b.kind === "folded-lane" &&
    a.laneId === b.laneId &&
    a.stage === b.stage
  );
};

/** Returns whether `x` is left of the first column, past the half gap that still counts as inside it. */
const isLeftOfColumns = (columns: readonly StageColumn[], x: number): boolean => {
  const first = columns[0];
  return first === undefined || x < first.left - HALF_COLUMN_GAP;
};

/** Returns the stage of the column at `x`: the last column that starts at or left of it, and the first for a pointer left of all. */
const pickStage = (columns: readonly StageColumn[], x: number): BoardStage | undefined => {
  let picked = columns[0];
  for (const column of columns) {
    if (x >= column.left - HALF_COLUMN_GAP) picked = column;
  }
  return picked?.stage;
};

/** Returns the lane the pointer is over, or the nearest one when it is above, below or between lanes. */
const pickLane = (lanes: readonly LaneBox[], y: number): LaneBox | undefined => {
  let nearest: LaneBox | undefined;
  let nearestGap = Infinity;
  for (const lane of lanes) {
    const gap = y < lane.top ? lane.top - y : y > lane.bottom ? y - lane.bottom : 0;
    if (gap < nearestGap) {
      nearest = lane;
      nearestGap = gap;
    }
  }
  return nearest;
};

/** Returns how many of `rows` the pointer is below the middle of: the number of the place the card would take. */
const pickRowIndex = (rows: readonly CellRow[], y: number): number =>
  rows.filter((row) => row.middle <= y).length;

/**
 * Returns where a card carried to the pointer at (`x`, `y`) would land, or
 * `null` when the board has no lane.
 *
 * - The lane is the one under `y`, else the nearest. The stage is the column
 *   at `x`.
 * - In an open lane, the card takes the place after every card whose middle
 *   is above `y`. A cell with no card gives place 0.
 * - A folded lane is a target as a whole: nothing in it can hold a slot.
 */
export const chooseDropPlace = (
  geometry: BoardGeometry,
  x: number,
  y: number,
): DropPlace | null => {
  const lane = pickLane(geometry.lanes, y);
  if (lane === undefined) return null;
  if (lane.isFolded) {
    return {
      kind: "folded-lane",
      laneId: lane.id,
      stage: isLeftOfColumns(geometry.columns, x) ? null : (pickStage(geometry.columns, x) ?? null),
    };
  }
  const stage = pickStage(geometry.columns, x);
  const cell = stage === undefined ? undefined : lane.cells.get(stage);
  if (stage === undefined || cell === undefined) return null;
  return { kind: "cell", laneId: lane.id, stage, index: pickRowIndex(cell.rows, y) };
};

/**
 * Returns how many pixels the board should scroll this frame for a carried
 * card at height `y`: negative to scroll up, positive to scroll down, and 0
 * when the card is clear of both edges. The deeper it is in a zone, the
 * faster it goes. The top zone is taller than the bottom one because the
 * toolbar and the stage names cover the top of the board.
 */
export const computeEdgeScrollSpeed = (y: number, viewTop: number, viewBottom: number): number => {
  if (y < viewTop + TOP_EDGE_ZONE) return -(viewTop + TOP_EDGE_ZONE - y) / EDGE_SCROLL_DIVISOR;
  if (y > viewBottom - BOTTOM_EDGE_ZONE)
    return (y - (viewBottom - BOTTOM_EDGE_ZONE)) / EDGE_SCROLL_DIVISOR;
  return 0;
};
