/**
 * The window's background colour: `--bg` of the theme in use (see
 * `decideThemeInUse`).
 *
 * Electron paints this colour before the page has drawn anything, so with it
 * the window never flashes white or black at launch or when the theme
 * changes. `tokens.css` defines `--bg` in oklch, which `BrowserWindow` does
 * not take, so the colours are kept here as sRGB hex: the oklch values
 * rounded to 8 bits. `base.css` gives the page these same hex values, so the
 * page and the window start from the same bytes; base.css explains why. A
 * unit test checks that all three stay equal.
 */
import type { Appearance } from "../ipc/contract";
import { decideThemeInUse, type Theme } from "../ipc/appearance";

/** Each theme's `--bg`, as sRGB hex. */
export const WINDOW_BACKGROUND: Readonly<Record<Theme, string>> = {
  whitehaven: "#f4f3f0",
  styles: "#f5eee3",
  "orient-express": "#1a1310",
  nile: "#0e1714",
  "end-house": "#1d1217",
};

/**
 * Returns the window's background colour: the `--bg` of the theme
 * `appearance` puts in use while macOS is dark (`darkAppearance`) or light.
 */
export const chooseWindowBackground = (appearance: Appearance, darkAppearance: boolean): string =>
  WINDOW_BACKGROUND[decideThemeInUse(appearance, darkAppearance)];
