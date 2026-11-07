/**
 * The shape of an opening sheet at each moment of its travel, as pure
 * numbers. `travel` is 0 where the card lies and 1 where the sheet stands
 * open, and every other number here is a function of it, so the sheet is
 * reversible from wherever it is.
 */

/** A rectangle in window pixels. */
export interface SheetRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The corner of the sheet where the card lies, which is the card's own. */
export const SHEET_CORNER_FROM = 12;

/** The corner of the sheet where it stands open. */
export const SHEET_CORNER_TO = 16;

/** How far below its place the content starts, in pixels. */
const CONTENT_RISE = 10;

/** Where on the travel the card's words are gone, and the sheet's paper is whole. */
const WORDS_GONE_AT = 0.55;

/** Where on the travel the content starts to fade in, and where it is whole. */
const CONTENT_FADES_FROM = 0.3;
const CONTENT_FADES_TO = 0.85;

/** What the sheet looks like at one moment of its travel. */
export interface SheetFrame {
  /** Where the visible window of the sheet is. */
  readonly rect: SheetRect;
  readonly radius: number;
  /** The opacity of the sheet's paper and its shadow, which come in as the card's words go. */
  readonly paperOpacity: number;
  /** The opacity of the card's own words, which the sheet covers. */
  readonly wordsOpacity: number;
  readonly contentOpacity: number;
  /** How far below its place the content is, in pixels. */
  readonly contentRise: number;
  /**
   * Where the content lies inside the window, so it stays at the destination
   * in the page while the window grows and never reflows: the offset of the
   * destination from the window's top left corner.
   */
  readonly contentOffset: { readonly x: number; readonly y: number };
}

/** Returns where `t` lies between `start` and `end`, from 0 to 1 and held there outside them. */
export const computePhaseProgress = (t: number, start: number, end: number): number =>
  Math.min(1, Math.max(0, (t - start) / (end - start)));

/** Returns the rectangle `t` of the way from `from` to `to`. */
export const blendRects = (from: SheetRect, to: SheetRect, t: number): SheetRect => ({
  left: from.left + (to.left - from.left) * t,
  top: from.top + (to.top - from.top) * t,
  width: from.width + (to.width - from.width) * t,
  height: from.height + (to.height - from.height) * t,
});

/**
 * Returns the sheet at `travel`, growing from `from` (the visible part of the
 * card) to `destination`. With no `from`, the card is not on the page, so the
 * sheet stays at the destination and only fades.
 */
export const computeSheetFrame = (
  from: SheetRect | null,
  destination: SheetRect,
  travel: number,
): SheetFrame => {
  const rect = from === null ? destination : blendRects(from, destination, travel);
  return {
    rect,
    radius: SHEET_CORNER_FROM + (SHEET_CORNER_TO - SHEET_CORNER_FROM) * travel,
    paperOpacity: from === null ? 1 : computePhaseProgress(travel, 0, WORDS_GONE_AT),
    wordsOpacity: 1 - computePhaseProgress(travel, 0, WORDS_GONE_AT),
    contentOpacity: computePhaseProgress(travel, CONTENT_FADES_FROM, CONTENT_FADES_TO),
    contentRise:
      CONTENT_RISE * (1 - computePhaseProgress(travel, CONTENT_FADES_FROM, CONTENT_FADES_TO)),
    contentOffset: { x: destination.left - rect.left, y: destination.top - rect.top },
  };
};

/** Returns whether two rectangles are the same to within half a pixel. */
export const isSameRect = (a: SheetRect, b: SheetRect): boolean =>
  Math.abs(a.left - b.left) < 0.5 &&
  Math.abs(a.top - b.top) < 0.5 &&
  Math.abs(a.width - b.width) < 0.5 &&
  Math.abs(a.height - b.height) < 0.5;
