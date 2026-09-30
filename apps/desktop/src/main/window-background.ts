/**
 * The window's background colour: `--bg` of the theme the window shows,
 * Whitehaven when macOS is light and Orient Express when it is dark.
 *
 * Electron paints this colour before the page has drawn anything, so with it
 * the window never flashes white or black at launch or when the appearance
 * changes. `tokens.css` defines `--bg` in oklch, which `BrowserWindow` does
 * not take, so the colours are kept here as sRGB hex: the oklch values
 * rounded to 8 bits. `base.css` gives the page these same hex values, so the
 * page and the window start from the same bytes; base.css explains why. A
 * unit test checks that all three stay equal.
 */
export const WINDOW_BACKGROUND = {
  /** Whitehaven's `--bg`. */
  light: "#f4f3f0",
  /** Orient Express's `--bg`. */
  dark: "#1a1310",
} as const;

/** Returns the window's background colour for the dark or the light appearance. */
export const chooseWindowBackground = (darkAppearance: boolean): string =>
  darkAppearance ? WINDOW_BACKGROUND.dark : WINDOW_BACKGROUND.light;
