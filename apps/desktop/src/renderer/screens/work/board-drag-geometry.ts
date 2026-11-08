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

/** Half the space between two stages: a pointer this close left of a stage still counts as inside it. */
const HALF_STAGE_GAP = 7;

/** The distance from the top edge of the board, in which a carried card scrolls the board up. */
const TOP_EDGE_ZONE = 130;

/** The distance from the bottom edge of the board, in which a carried card scrolls the board down. */
const BOTTOM_EDGE_ZONE = 70;

/** How many pixels the board scrolls per frame for each pixel the pointer is inside an edge zone, as a divisor. */
const EDGE_SCROLL_DIVISOR = 6;

/**
 * The share of a card's height, at the top and at the bottom, that does not
 * count as its middle. The middle 40% of a card is the part where a carried
 * card that rests means a merge.
 */
const MERGE_EDGE_SHARE = 0.3;

/** The left edge of one stage, where its cells start. */
export interface StageEdge {
  readonly stage: BoardStage;
  readonly left: number;
}

/**
 * A row of a cell: a card alone, or the lead of a stack. It has the id of the
 * card, the child of the cell that holds it (`element`: the card, or the stack
 * the card leads), the place the layout gave the card, and the vertical middle
 * of that place.
 */
export interface CellRow {
  readonly id: string;
  readonly element: HTMLElement;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly middle: number;
}

/** One cell of an open lane, with the cards it shows, top to bottom. The card in the hand is not among them. */
export interface CellBox {
  readonly element: HTMLElement;
  readonly rows: readonly CellRow[];
  /**
   * The index in `rows` of the last place a drop may take, set for a closed
   * cell that has a "13 more" line. A card dropped behind that line would be
   * hidden at once, so a drop below the last row shown takes that row's place
   * and the card it displaces slips into "13 more". Absent when the cell lets
   * a drop go anywhere.
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
  readonly stageEdges: readonly StageEdge[];
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
    return a.laneId === b.laneId && a.stage === b.stage && a.beforeCardId === b.beforeCardId;
  }
  return (
    a.kind === "folded-lane" &&
    b.kind === "folded-lane" &&
    a.laneId === b.laneId &&
    a.stage === b.stage
  );
};

/** Returns whether `x` is left of the first stage, past the half gap that still counts as inside it. */
const isLeftOfStages = (stageEdges: readonly StageEdge[], x: number): boolean => {
  const first = stageEdges[0];
  return first === undefined || x < first.left - HALF_STAGE_GAP;
};

/** Returns the stage at `x`: the last stage that starts at or left of it, and the first for a pointer left of all. */
const pickStage = (stageEdges: readonly StageEdge[], x: number): BoardStage | undefined => {
  let picked = stageEdges[0];
  for (const edge of stageEdges) {
    if (x >= edge.left - HALF_STAGE_GAP) picked = edge;
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
 * - The lane is the one under `y`, else the nearest. The stage is the one at
 *   `x`.
 * - In an open lane, the card takes the place after every card whose middle
 *   is above `y`, but never past the cell's `lastIndex`. The place is named by
 *   the card it goes before, or `null` at the end of the cell.
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
      stage: isLeftOfStages(geometry.stageEdges, x)
        ? null
        : (pickStage(geometry.stageEdges, x) ?? null),
    };
  }
  const stage = pickStage(geometry.stageEdges, x);
  const cell = stage === undefined ? undefined : lane.cells.get(stage);
  if (stage === undefined || cell === undefined) return null;
  const index = Math.min(pickRowIndex(cell.rows, y), cell.lastIndex ?? Infinity);
  return { kind: "cell", laneId: lane.id, stage, beforeCardId: cell.rows[index]?.id ?? null };
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

/** The card a carried card would merge into, and the place the carry shows while it is over that card. */
export interface MergeCandidate {
  readonly cardId: string;
  /** The place right after the card, so the card stays under the pointer when the slot opens in its cell. */
  readonly place: DropPlace;
}

/**
 * Returns the card whose middle 40% the point (`x`, `y`) is over, or `null`.
 * The middle means merge, and it moves no slot: a place beside it is the
 * only one that keeps the card under the pointer. A card in a folded lane,
 * behind a "13 more" line, or in the hand is not on the board, so none is
 * found.
 */
export const findMergeCandidate = (
  geometry: BoardGeometry,
  x: number,
  y: number,
): MergeCandidate | null => {
  for (const lane of geometry.lanes) {
    if (lane.isFolded || y < lane.top || y > lane.bottom) continue;
    for (const [stage, cell] of lane.cells) {
      const index = cell.rows.findIndex(
        (row) =>
          x > row.left &&
          x < row.right &&
          y > row.top + (row.bottom - row.top) * MERGE_EDGE_SHARE &&
          y < row.bottom - (row.bottom - row.top) * MERGE_EDGE_SHARE,
      );
      const row = cell.rows[index];
      if (row === undefined) continue;
      const nextIndex = Math.min(index + 1, cell.lastIndex ?? Infinity);
      return {
        cardId: row.id,
        place: {
          kind: "cell",
          laneId: lane.id,
          stage,
          beforeCardId: cell.rows[nextIndex]?.id ?? null,
        },
      };
    }
  }
  return null;
};
