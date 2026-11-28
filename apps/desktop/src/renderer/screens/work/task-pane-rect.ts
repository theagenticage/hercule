import type { SheetRect } from "../desk";

/** The pane's width when the desk is wide enough, in pixels. */
const PANE_WIDTH = 468;
/** The room the pane leaves at the right and at the bottom of the desk. */
const PANE_RIGHT = 14;
const PANE_BOTTOM = 14;
/** How far down the pane starts, below the toolbar. */
const PANE_TOP = 58;
/** The room the pane leaves beside it on a desk too narrow for its width. */
const NARROW_SIDE_ROOM = 40;

/**
 * Returns the box of the open details pane over a desk of `desk`'s size, in
 * window pixels: 468 wide, 14 from the right, from 58 down to 14 from the
 * bottom. It floats over the board and never splits it. On a desk too narrow
 * for that width it leaves 40 beside it.
 */
export const computeTaskPaneRect = (desk: {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}): SheetRect => {
  const width = Math.min(PANE_WIDTH, desk.width - NARROW_SIDE_ROOM);
  return {
    left: desk.left + desk.width - width - PANE_RIGHT,
    top: desk.top + PANE_TOP,
    width,
    height: desk.height - PANE_TOP - PANE_BOTTOM,
  };
};
