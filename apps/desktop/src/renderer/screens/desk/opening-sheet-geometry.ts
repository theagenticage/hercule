/**
 * The numbers behind a sheet that opens out of a card: what each part of it
 * looks like at every moment of the opening. One number
 * `p` runs from 0 (the sheet is the card) to 1 (the sheet is open), and a
 * spring may carry it a little past 1 or below 0. Everything the sheet draws
 * is a function of `p`, so reversing halfway is only `p` turning round.
 */

/** A rectangle in the pixels of the layer the sheet is drawn in. */
export interface SheetRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The corner of the sheet while it is a card, and once it is open, in pixels. */
const CARD_CORNER = 12;
const OPEN_CORNER = 16;

/**
 * The part of the opening in which the card's words fade out (until 0.55),
 * and the sheet's own words fade in (from 0.3 to 0.85). The two overlap, so
 * there is never a blank sheet between them.
 */
const CARD_WORDS_GONE_AT = 0.55;
const SHEET_WORDS_FROM = 0.3;
const SHEET_WORDS_TO = 0.85;

/** How far the sheet's words rise while they fade in, in pixels. */
const SHEET_WORDS_RISE = 10;

const clamp = (value: number): number => Math.max(0, Math.min(1, value));
const lerp = (from: number, to: number, p: number): number => from + (to - from) * p;

/**
 * Returns the place a sheet grows from when the page has nothing that stands
 * for the thing it opens: a smaller sheet inside the open one, so it still
 * grows and does not appear from nowhere.
 */
export const computeFallbackOrigin = (open: SheetRect): SheetRect => ({
  left: open.left + 40,
  top: open.top + 40,
  width: Math.max(0, open.width - 80),
  height: 200,
});

/** The sheet's box and corner at one moment of the opening. */
export interface SheetFrame {
  readonly rect: SheetRect;
  /** The corner radius, in pixels. */
  readonly corner: number;
}

/**
 * Returns the sheet's box and corner at `p`. Its position follows `p` as it is,
 * and its size never goes below nothing, so a spring that dips under 0 does
 * not turn the sheet inside out.
 */
export const interpolateSheetFrame = (from: SheetRect, to: SheetRect, p: number): SheetFrame => {
  const size = Math.max(0, p);
  return {
    rect: {
      left: lerp(from.left, to.left, p),
      top: lerp(from.top, to.top, p),
      width: lerp(from.width, to.width, size),
      height: lerp(from.height, to.height, size),
    },
    corner: lerp(CARD_CORNER, OPEN_CORNER, clamp(p)),
  };
};

/** Returns how opaque the card's words are at `p`: solid on the card, gone by 0.55. */
export const computeCardWordsOpacity = (p: number): number => clamp(1 - p / CARD_WORDS_GONE_AT);

/** How the sheet's own words look at one moment: their opacity, and how far below their place they still are. */
export interface SheetWords {
  readonly opacity: number;
  readonly rise: number;
}

/** Returns how the sheet's own words look at `p`: faded in from 0.3 to 0.85, rising 10px as they do. */
export const computeSheetWords = (p: number): SheetWords => {
  const opacity = clamp((p - SHEET_WORDS_FROM) / (SHEET_WORDS_TO - SHEET_WORDS_FROM));
  return { opacity, rise: (1 - opacity) * SHEET_WORDS_RISE };
};

/**
 * Returns how far the opening has come, from 0 (a card) to 1 (open), held
 * inside that range. The sheet writes it as `--sheet-progress`, so the parts
 * of a page that follow the opening (a head sliding along the top edge, the
 * dimming of what is behind) can use it in their own stylesheets.
 */
export const computeSheetProgress = clamp;
