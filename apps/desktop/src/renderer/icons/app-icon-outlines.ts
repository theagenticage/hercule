/**
 * The outlines, as SVG path data, of the icons the Bureau book does not draw.
 * Each icon's component draws them in `IconFrame`. They live in a `.ts` file
 * of their own so that the reference sheet of `pnpm compare:bureau` can draw
 * them in the book's own frame without loading a React component: the
 * comparison then checks that the app's frame draws them as the book's frame
 * would, at every size the pages use.
 *
 * They follow the book's rules for its icons: a 16-unit grid, drawn between
 * 2.4 and 13.6, with corners of radius 1 to 1.2.
 */

/** The Overview icon: four squares in a grid. */
export const OVERVIEW_ICON_OUTLINES: ReadonlyArray<string> = [
  "M2.4 3.6a1.2 1.2 0 0 1 1.2-1.2h2.2a1.2 1.2 0 0 1 1.2 1.2v2.2a1.2 1.2 0 0 1-1.2 1.2H3.6a1.2 1.2 0 0 1-1.2-1.2z",
  "M9 3.6a1.2 1.2 0 0 1 1.2-1.2h2.2a1.2 1.2 0 0 1 1.2 1.2v2.2a1.2 1.2 0 0 1-1.2 1.2h-2.2A1.2 1.2 0 0 1 9 5.8z",
  "M2.4 10.2A1.2 1.2 0 0 1 3.6 9h2.2a1.2 1.2 0 0 1 1.2 1.2v2.2a1.2 1.2 0 0 1-1.2 1.2H3.6a1.2 1.2 0 0 1-1.2-1.2z",
  "M9 10.2A1.2 1.2 0 0 1 10.2 9h2.2a1.2 1.2 0 0 1 1.2 1.2v2.2a1.2 1.2 0 0 1-1.2 1.2h-2.2A1.2 1.2 0 0 1 9 12.4z",
];
