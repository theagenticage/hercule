/**
 * What every captured sheet does the same way: take its theme from the URL,
 * hold a Bureau book page still, read the book's crew.js, and tell the
 * capture when it is ready.
 */
import { waitForPresentedFrame } from "../app/presented-frame";

/** The two themes the sheets are compared in: Whitehaven (light) and Orient Express (dark). */
const THEMES = ["whitehaven", "orient-express"];

/**
 * Sets the theme named by the page's `?theme=` on `<html>`, Whitehaven when
 * the URL names none. Fails on any other name, because a sheet drawn in a
 * theme the comparison does not expect would only show up as a flood of
 * differing pixels.
 */
export function applySheetTheme(): void {
  const theme = new URLSearchParams(location.search).get("theme") ?? "whitehaven";
  if (!THEMES.includes(theme)) {
    throw new Error(
      `Unknown theme "${theme}" in the URL. Use ?theme=whitehaven or ?theme=orient-express.`,
    );
  }
  document.documentElement.dataset.theme = theme;
}

/**
 * Sets `data-ready` on `<html>` once the sheet can be captured: every CSS
 * transition has ended, its fonts have loaded, and a frame that holds the
 * whole sheet has been presented (see `waitForPresentedFrame`). Call it
 * after the sheet's cells are in the document.
 *
 * A transition that still runs, such as the composer's shrink, would be
 * captured halfway. The capture copies the latest frame the page has sent to
 * the GPU process, and a presented frame has been sent there; after two
 * animation frames, the sheet's frame may still be on its way.
 */
export async function markSheetReady(): Promise<void> {
  await Promise.all(
    document
      .getAnimations()
      .filter((animation) => animation instanceof CSSTransition)
      // A transition that another one replaces rejects `finished`, and has
      // ended all the same.
      .map((animation) => animation.finished.catch(() => undefined)),
  );
  await waitForPresentedFrame();
  document.documentElement.dataset.ready = "";
}

/**
 * Returns the scroll position the book's `?state=scrolled` page gives its
 * transcript: 42% of the way down, as crew.js computes it.
 */
export function computeScrolledTop(transcript: Element): number {
  return Math.round((transcript.scrollHeight - transcript.clientHeight) * 0.42);
}

/** The part of the Bureau book's crew.js that the reference pages use. */
export interface Crew {
  /** Returns the SVG markup of a face, a You mark, a state mark or an icon. */
  face(
    name: string,
    opts: { pose: string; size: number; look?: { hue: string; shape: string; acc: string } },
  ): string;
  you(size: number): string;
  mark(state: string, size: number): string;
  icon(name: string, size: number): string;
  /** Replaces every placeholder under `root`, such as `<i data-i="stop">`, with its SVG. */
  drawPlaceholders(root: ParentNode): void;
  /** The book's rows of Waiting on you: each item's full name, and the shorter name the row shows. */
  readonly WAITING: ReadonlyArray<{ readonly name: string; readonly short: string }>;
}

/**
 * Returns the `Crew` object that the book's crew.js sets on `window`. Fails
 * when crew.js has not run on this page: a reference page must load
 * /design/crew-bureau/crew.js before its module.
 */
export function readCrew(): Crew {
  const { Crew: crew } = window as Window & { readonly Crew?: Crew };
  if (crew === undefined) {
    throw new Error(
      "The Bureau book's crew.js has not run on this page. Load /design/crew-bureau/crew.js before this module.",
    );
  }
  return crew;
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
