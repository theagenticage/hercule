/**
 * What every captured sheet does the same way: take its theme and glass from
 * the URL, hold the page still, read the Bureau book's crew.js, and tell the
 * capture when it is ready.
 */
import {
  DAY_THEMES,
  DEFAULT_APPEARANCE,
  NIGHT_THEMES,
  TEXT_SIZE_STEPS,
  THEMES,
  type TextSizeStep,
  type Theme,
} from "../../ipc/appearance";
import type { Appearance } from "../../ipc/contract";
import { waitForPresentedFrame } from "../app/presented-frame";
import type { Look } from "../faces/look";
import { BROKEN_VARIANTS, buildBrokenVariantCss, type BrokenVariant } from "./broken-variants";
import { ALL_THEMES } from "./sheet-themes";

/**
 * Returns the theme the page's `?theme=` names, Whitehaven when the URL
 * names none. Fails on a name that is not one of the six themes, because the
 * page would otherwise be drawn in no theme at all.
 */
function readSheetTheme(): Theme {
  const name = new URLSearchParams(location.search).get("theme") ?? "whitehaven";
  const theme = THEMES.find((each) => each === name);
  if (theme === undefined) {
    throw new Error(`Unknown theme "${name}" in the URL. Use one of: ${ALL_THEMES.join(", ")}.`);
  }
  return theme;
}

/**
 * Returns the Glass level the page's `?glass=` names, or `undefined` when the
 * URL names none. Fails on anything but a whole number from 0 to 100.
 */
function readSheetGlass(): number | undefined {
  const value = new URLSearchParams(location.search).get("glass");
  if (value === null) return undefined;
  const glassPercent = /^\d{1,3}$/.test(value) ? Number(value) : NaN;
  if (!(glassPercent <= 100)) {
    throw new Error(`Unknown glass "${value}" in the URL. Use a whole number from 0 to 100.`);
  }
  return glassPercent;
}

/**
 * Returns the broken look the page's `?broken=` names, or `undefined` when the
 * URL names none. Fails on a name that is not one of the broken looks.
 */
function readSheetBroken(): BrokenVariant | undefined {
  const name = new URLSearchParams(location.search).get("broken");
  if (name === null) return undefined;
  const variant = BROKEN_VARIANTS.find((each) => each === name);
  if (variant === undefined) {
    throw new Error(
      `Unknown broken look "${name}" in the URL. Use one of: ${BROKEN_VARIANTS.join(", ")}.`,
    );
  }
  return variant;
}

/**
 * Returns the step of the Text size the page's `?text-size=` names, or
 * `undefined` when the URL names none. Fails on anything but 1, 2, 3 or 4.
 */
function readSheetTextSize(): TextSizeStep | undefined {
  const value = new URLSearchParams(location.search).get("text-size");
  if (value === null) return undefined;
  const step = TEXT_SIZE_STEPS.find((each) => String(each) === value);
  if (step === undefined) {
    throw new Error(`Unknown text size "${value}" in the URL. Use 1, 2, 3 or 4.`);
  }
  return step;
}

/**
 * Draws the page in the look its URL names: the theme of `?theme=`
 * (Whitehaven when the URL names none), the Glass level of `?glass=`, a
 * whole number from 0 to 100 (the 40 of base.css when the URL names none),
 * and the Text size step of `?text-size=`, from 1 to 4 (the default 2, which
 * changes nothing, when the URL names none). Fails on a theme that is not one
 * of the six, a glass that is not a whole number from 0 to 100, or a text
 * size that is not 1, 2, 3 or 4.
 *
 * `?broken=` (`max-contrast`, `cramped` or `noisy`) also overrides tokens, for
 * the UI council's calibration images; without it the page is untouched. Fails
 * on any other value.
 *
 * Glass and Text size are set the way `public/theme-init.js` sets them in the
 * app. Both parts of glass are needed: `--glass-percent` sets the glass level
 * of every surface, and `data-solid-glass` turns the backdrop filter off,
 * which a level of 0 alone would still draw.
 */
export function applySheetAppearance(): void {
  const root = document.documentElement;
  root.dataset.theme = readSheetTheme();
  const broken = readSheetBroken();
  if (broken !== undefined) {
    const style = document.createElement("style");
    style.textContent = buildBrokenVariantCss(broken, { day: DAY_THEMES, night: NIGHT_THEMES });
    document.head.append(style);
  }
  const textSize = readSheetTextSize();
  if (textSize !== undefined) root.dataset.textSize = String(textSize);
  const glassPercent = readSheetGlass();
  if (glassPercent === undefined) return;
  root.style.setProperty("--glass-percent", String(glassPercent));
  root.toggleAttribute("data-solid-glass", glassPercent === 0);
}

/**
 * Returns the Appearance a Mac would hold for the page the URL describes, so
 * that Settings > Appearance draws the page's own theme, glass and text size.
 * It is the default Appearance with the Glass level of `?glass=`, the Text
 * size step of `?text-size=`, and the page's theme
 * set as the theme Follow the system would use: the day theme for a light
 * theme, the night theme for a dark one. Fails like `applySheetAppearance`.
 */
export function readSheetAppearance(): Appearance {
  const theme = readSheetTheme();
  const glassPercent = readSheetGlass() ?? DEFAULT_APPEARANCE.glassPercent;
  const textSize = readSheetTextSize() ?? DEFAULT_APPEARANCE.textSize;
  const dayTheme = DAY_THEMES.find((each) => each === theme);
  const nightTheme = NIGHT_THEMES.find((each) => each === theme);
  return {
    ...DEFAULT_APPEARANCE,
    theme,
    glassPercent,
    textSize,
    dayTheme: dayTheme ?? DEFAULT_APPEARANCE.dayTheme,
    nightTheme: nightTheme ?? DEFAULT_APPEARANCE.nightTheme,
  };
}

/**
 * Sets `data-ready` on `<html>` once the sheet can be captured: every CSS
 * transition and every animation that ends has ended, its fonts have loaded,
 * and a frame that holds the whole sheet has been presented (see
 * `waitForPresentedFrame`). Call it after the sheet's cells are in the
 * document.
 *
 * A transition or an entrance animation that still runs, such as the
 * composer's shrink or an open workflow sliding in, would be captured
 * halfway. An animation that repeats forever, such as a working face, never
 * ends, so it is not waited for. The capture copies the latest frame the page has sent to
 * the GPU process, and a presented frame has been sent there; after two
 * animation frames, the sheet's frame may still be on its way.
 */
export async function markSheetReady(): Promise<void> {
  await Promise.all(
    document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
      // A transition that another one replaces rejects `finished`, and has
      // ended all the same; so does an animation its element dropped.
      .map((animation) => animation.finished.catch(() => undefined)),
  );
  await waitForPresentedFrame();
  document.documentElement.dataset.ready = "";
}

/** The widths a list page draws its list at, as the page's `?view=` names them. */
const LIST_VIEWS = ["table", "split", "full"] as const;

/**
 * Returns the width the page's `?view=` names, `table` when the URL names
 * none. Fails when it names anything but `table`, `split` or `full`.
 */
export function readListView(): (typeof LIST_VIEWS)[number] {
  const view = new URLSearchParams(location.search).get("view") ?? "table";
  const known = LIST_VIEWS.find((each) => each === view);
  if (known === undefined) {
    throw new Error(`Unknown view "${view}" in the URL. Use one of: ${LIST_VIEWS.join(", ")}.`);
  }
  return known;
}

/**
 * Returns the scroll position the thread page's `?state=scrolled` gives its
 * transcript: 42% of the way down.
 */
export function computeScrolledTop(transcript: Element): number {
  return Math.round((transcript.scrollHeight - transcript.clientHeight) * 0.42);
}

/** The part of the Bureau book's crew.js that the reference sheet uses. */
export interface Crew {
  /** Returns the SVG markup of a face, a You mark, a state mark or an icon. */
  face(name: string, opts: { pose: string; size: number; look?: BookLook }): string;
  you(size: number): string;
  mark(state: string, size: number): string;
  icon(name: string, size: number): string;
}

/**
 * Returns the `Crew` object that the book's crew.js sets on `window`. Fails
 * when crew.js has not run on this page: the reference sheet must load
 * /design/crew-bureau-2/crew.js before its module.
 */
export function readCrew(): Crew {
  const { Crew: crew } = window as Window & { readonly Crew?: Crew };
  if (crew === undefined) {
    throw new Error(
      "The Bureau book's crew.js has not run on this page. Load /design/crew-bureau-2/crew.js before this module.",
    );
  }
  return crew;
}

/** A look as crew.js's `face` takes it. */
export interface BookLook {
  readonly hue: string;
  readonly shape: string;
  /** What the face wears, joined by "+", such as "tache+bowtie", or "none". */
  readonly acc: string;
}

/**
 * Converts the app's `look` into the look crew.js's `face` takes. The book
 * keeps headwear in the same list as the accessories, and draws that list in
 * order, so the headwear comes last, as the app draws it.
 */
export function buildBookLook({ hue, shape, accessories, headwear }: Look): BookLook {
  const worn = headwear === null ? accessories : [...accessories, headwear];
  return { hue, shape, acc: worn.join("+") || "none" };
}

/**
 * Holds a Bureau book page still for a capture: stops every animation, so a
 * waiting face shows the frame the app draws, and hides the traffic-light
 * placeholders (`.tl`), where macOS draws the real ones over the app's
 * window.
 */
export function stillBookPage(): void {
  const style = document.createElement("style");
  style.textContent = "* { animation: none !important; } .tl { visibility: hidden; }";
  document.head.append(style);
}

/**
 * Draws a workflow graph's pane the same way on every capture. Chromium
 * draws two parts of the pane a little differently from one capture to the
 * next, so the same page differed by 30 to 380 pixels at random:
 *
 * - the fade at a cut edge, which is a CSS mask, so the pane loses it;
 * - a pane that scrolls, which Chromium draws on a layer of its own, so the
 *   pane stops scrolling. The graph stays where it opened, with no scroll
 *   bar.
 */
export function stillGraphPane(): void {
  const style = document.createElement("style");
  style.textContent = ".graph-pane { mask-image: none !important; overflow: hidden !important; }";
  document.head.append(style);
}
