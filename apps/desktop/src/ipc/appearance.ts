/**
 * The themes of the Appearance (spec 17 §Settings, Appearance), the rule
 * that picks the one in use, and the Appearance before the user changes it.
 * Main and the renderer both need them at run time, so they live here with
 * no Effect: the renderer imports this file, and `./contract.ts` builds the
 * Appearance's schema from it.
 */
import type { Appearance } from "./contract";

/** Bureau's five themes, in the order the Appearance page shows them. */
export const THEMES = ["whitehaven", "styles", "orient-express", "nile", "end-house"] as const;
export type Theme = (typeof THEMES)[number];

/** The light themes, which Follow the system may use by day. */
export const DAY_THEMES = ["whitehaven", "styles"] as const satisfies ReadonlyArray<Theme>;
export type DayTheme = (typeof DAY_THEMES)[number];

/** The dark themes, which Follow the system may use by night. */
export const NIGHT_THEMES = [
  "orient-express",
  "nile",
  "end-house",
] as const satisfies ReadonlyArray<Theme>;
export type NightTheme = (typeof NIGHT_THEMES)[number];

/** The part of the Appearance that decides the theme in use. */
type ThemeChoice = Pick<Appearance, "theme" | "followSystem" | "dayTheme" | "nightTheme">;

/**
 * Returns the theme in use: with Follow the system on, the night theme while
 * macOS is dark (`darkAppearance`) and the day theme otherwise; with it off,
 * the chosen theme.
 *
 * `public/theme-init.js` repeats this rule, because it runs before any
 * bundle loads; its test checks that the two agree.
 */
export const decideThemeInUse = (choice: ThemeChoice, darkAppearance: boolean): Theme => {
  if (!choice.followSystem) return choice.theme;
  return darkAppearance ? choice.nightTheme : choice.dayTheme;
};

/**
 * The Appearance before the user changes it, the app's look before the
 * Appearance page existed (spec 17 §Settings, Appearance): Follow the system,
 * Whitehaven by day and Orient Express by night, with the book's 40% glass.
 * `theme` is used only once Follow the system is turned off, and a picked
 * theme replaces it then.
 */
export const DEFAULT_APPEARANCE: Appearance = {
  theme: "whitehaven",
  followSystem: true,
  dayTheme: "whitehaven",
  nightTheme: "orient-express",
  glassPercent: 40,
  reduceTransparency: false,
  density: "comfortable",
  textSize: 2,
  openOn: "threads",
  reduceMotion: false,
  marks: true,
};
