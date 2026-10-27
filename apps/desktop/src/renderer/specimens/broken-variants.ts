/**
 * The three deliberately broken looks of the UI council's calibration set
 * (docs/design/ui-council/BRIEF.md, section 9). A specimen page draws one of
 * them when its URL has `?broken=<variant>`; see `applySheetAppearance`.
 *
 * Each look is a stylesheet that overrides tokens on `:root` and on every
 * `[data-theme]` scope, with `!important` so that it wins over the theme
 * rules of tokens.css wherever they sit. A look is deterministic: it reads
 * nothing from the page.
 *
 * The capture scripts run on Node and import this file by its path, so it
 * imports nothing; the callers pass in the lists of light and dark themes.
 */

/** The themes by kind: the light themes (`day`) and the dark themes (`night`). */
export interface ThemesByKind {
  readonly day: ReadonlyArray<string>;
  readonly night: ReadonlyArray<string>;
}

/** The broken looks, as `?broken=` names them. */
export const BROKEN_VARIANTS = ["max-contrast", "cramped", "noisy"] as const;
export type BrokenVariant = (typeof BROKEN_VARIANTS)[number];

/**
 * Returns a selector that matches every element of the given themes, `<html>`
 * included, because a specimen page sets `data-theme` on it. It leaves
 * `:root` out: `:root` and `[data-theme]` weigh the same, so a `:root` in
 * the dark themes' rule would win over the light themes' rule on `<html>`.
 */
function selectThemes(themes: ReadonlyArray<string>): string {
  return themes.map((theme) => `[data-theme="${theme}"]`).join(",\n");
}

/** Every `[data-theme]` scope, so that a theme preview nested in a page is overridden too. */
const EVERY_SCOPE = ":root,\n[data-theme]";

/**
 * Returns the `max-contrast` stylesheet. `--ink` is pure black in the light
 * themes and pure white in the dark themes; `--muted`, `--faint`, `--line`,
 * `--line-soft` and `--divider` equal it. The backgrounds stay as the theme has them.
 */
function buildMaxContrastCss({ day, night }: ThemesByKind): string {
  const body = (ink: string): string => `{
  --ink: ${ink} !important;
  --muted: ${ink} !important;
  --faint: ${ink} !important;
  --line: ${ink} !important;
  --line-soft: ${ink} !important;
  --divider: ${ink} !important;
}`;
  return `${selectThemes(day)} ${body("black")}\n${selectThemes(night)} ${body("white")}`;
}

/**
 * Returns the `cramped` stylesheet. The component CSS spells nearly all its
 * spacing as literal pixels, not as `--s-*` tokens, so no token override can
 * halve it. This is the simple, deterministic stand-in:
 *
 * - the `--s-*` scale is halved;
 * - line height is 1.15 and letter spacing -0.01em on every element;
 * - every element loses its vertical padding;
 * - every flex or grid container gets a 2px gap.
 *
 * Margins are left alone: layouts push things apart with `margin-top: auto`.
 */
function buildCrampedCss(): string {
  return `${EVERY_SCOPE} {
  --s-1: 2px !important;
  --s-2: 4px !important;
  --s-3: 6px !important;
  --s-4: 8px !important;
  --s-5: 10px !important;
  --s-6: 12px !important;
  --s-8: 16px !important;
}
* {
  line-height: 1.15 !important;
  letter-spacing: -0.01em !important;
  padding-block: 0 !important;
  gap: 2px !important;
}`;
}

/**
 * Returns the `noisy` stylesheet:
 *
 * - every crew hue at a chroma of 0.3;
 * - `--bg`, `--surface`, `--raised` and `--sunken` each a different saturated
 *   hue (25, 145, 250, 320), at the lightness the flagship theme of their
 *   kind gives them (Whitehaven for the light themes, Orient Express for the
 *   dark ones);
 * - every border that exists is 2px wide, in a visible colour, and every
 *   element that has a class gets a 2px outline besides.
 */
function buildNoisyCss({ day, night }: ThemesByKind): string {
  const surfaces = (bg: number, surface: number, raised: number, sunken: number): string => `{
  --char-c: 0.3 !important;
  --char-tint-c: 0.3 !important;
  --bg: oklch(${String(bg)} 0.3 25) !important;
  --surface: oklch(${String(surface)} 0.3 145) !important;
  --raised: oklch(${String(raised)} 0.3 250) !important;
  --sunken: oklch(${String(sunken)} 0.3 320) !important;
  --line: color-mix(in oklab, var(--ink) 55%, transparent) !important;
  --line-soft: color-mix(in oklab, var(--ink) 40%, transparent) !important;
  --divider: color-mix(in oklab, var(--ink) 40%, transparent) !important;
}`;
  return `${selectThemes(day)} ${surfaces(0.965, 0.99, 1, 0.945)}
${selectThemes(night)} ${surfaces(0.195, 0.235, 0.275, 0.172)}
* {
  border-width: 2px !important;
}
*:where([class]) {
  outline: 2px solid color-mix(in oklab, var(--ink) 45%, transparent) !important;
  outline-offset: -2px !important;
}`;
}

/** Returns the stylesheet text that draws a page in the broken `variant`, given the light and dark themes. */
export function buildBrokenVariantCss(variant: BrokenVariant, themes: ThemesByKind): string {
  switch (variant) {
    case "max-contrast":
      return buildMaxContrastCss(themes);
    case "cramped":
      return buildCrampedCss();
    case "noisy":
      return buildNoisyCss(themes);
  }
}
