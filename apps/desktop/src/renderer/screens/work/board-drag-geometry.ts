/**
 * Where a carried card would land, worked out from measurements of the board
 * taken once (at the lift, and after each change of the page or the slot).
 * Nothing here reads the page, so the pointer's frame loop does no layout.
 *
 * The measurements are in board coordinates: pixels from the top left of the
 * board's scrolled content, so they stay true while the board scrolls. A
 * pointer position in the window becomes one with `toBoardPoint`.
 */
import type { DropPlace } from "@hercule/client-core/work";
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
  /**
   * The last place a drop may take, set for a closed cell that has a "13 more"
   * line. A card dropped behind that line would be hidden at once, so a drop
   * below the last row shown takes that row's place and the card it displaces
   * slips into "13 more". Absent when the cell lets a drop go anywhere.
   */
  readonly lastIndex?: number;
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

/** Everything `chooseDropPlace` needs, in board coordinates. */
export interface BoardGeometry {
  readonly columns: readonly StageColumn[];
  readonly lanes: readonly LaneBox[];
}

/** The scroller as the window sees it: where its top left is, how far it is scrolled, and where its bottom is. */
export interface BoardView {
  readonly left: number;
  readonly top: number;
  readonly bottom: number;
  readonly scrollLeft: number;
  readonly scrollTop: number;
}

/** Returns the point of the board that lies under the window position (`x`, `y`). */
export const toBoardPoint = (
  view: BoardView,
  x: number,
  y: number,
): { readonly x: number; readonly y: number } => ({
  x: x - view.left + view.scrollLeft,
  y: y - view.top + view.scrollTop,
});

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
 *   is above `y`, but never past the cell's `lastIndex`. A cell with no card
 *   gives place 0.
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
  const index = Math.min(pickRowIndex(cell.rows, y), cell.lastIndex ?? Infinity);
  return { kind: "cell", laneId: lane.id, stage, index };
};

/**
 * Returns how many pixels the board should scroll this frame for a carried
 * card at window height `y`, when the board's top and bottom edges are at the
 * window heights `viewTop` and `viewBottom`: negative to scroll up, positive to scroll down, and 0
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
