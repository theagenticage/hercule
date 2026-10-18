/**
 * What every captured sheet does the same way: take its theme from the URL,
 * hold a Bureau book page still, read the book's crew.js, and tell the
 * capture when it is ready.
 */
import { waitForPresentedFrame } from "../app/presented-frame";
import type { Look } from "../faces/look";
import { ALL_THEMES } from "./sheet-themes";

/**
 * Sets the theme named by the page's `?theme=` on `<html>`, Whitehaven when
 * the URL names none. Fails on a name that is not one of the five themes,
 * because the page would otherwise be drawn in no theme at all.
 */
export function applySheetTheme(): void {
  const theme = new URLSearchParams(location.search).get("theme") ?? "whitehaven";
  if (!ALL_THEMES.includes(theme)) {
    throw new Error(`Unknown theme "${theme}" in the URL. Use one of: ${ALL_THEMES.join(", ")}.`);
  }
  document.documentElement.dataset.theme = theme;
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

/** The widths a list page draws its list at, as the book's `?view=` names them. */
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
 * Returns the scroll position the book's `?state=scrolled` page gives its
 * transcript: 42% of the way down, as crew.js computes it.
 */
export function computeScrolledTop(transcript: Element): number {
  return Math.round((transcript.scrollHeight - transcript.clientHeight) * 0.42);
}

/**
 * Scrolls the transcript away from its bottom, to the top `computeTop`
 * returns for it, and returns once the composer has shrunk. Fails when the
 * page has no transcript.
 */
export async function scrollTranscriptAway(
  computeTop: (transcript: Element) => number,
): Promise<void> {
  const transcript = document.querySelector(".transcript");
  if (transcript === null) throw new Error("The thread specimen draws no transcript.");
  // A reader scrolls only once the page has been drawn. By then the
  // transcript has noted that it opened at the bottom, so the scroll below
  // counts as a scroll up, which is what shrinks the composer.
  for (let frame = 0; frame < 2; frame += 1) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  // The composer shrinks after the scroll event, which arrives with a later
  // frame. The scroll is made again on each frame until then, because a
  // late change in the page's height can make the transcript follow its
  // bottom again before that event arrives.
  while (document.querySelector(".composer.is-scrolled") === null) {
    transcript.scrollTop = computeTop(transcript);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

/** The part of the Bureau book's crew.js that the reference pages use. */
export interface Crew {
  /** Returns the SVG markup of a face, a You mark, a state mark or an icon. */
  face(name: string, opts: { pose: string; size: number; look?: BookLook }): string;
  you(size: number): string;
  mark(state: string, size: number): string;
  icon(name: string, size: number): string;
  /** Returns the SVG markup of a source's mark, such as `claude` or `openai`, `size` pixels square. */
  brand(name: string, size: number): string;
  /** Replaces every placeholder under `root`, such as `<i data-i="stop">`, with its SVG. */
  drawPlaceholders(root: ParentNode): void;
  /** The book's rows of Waiting on you: each item's full name, and the shorter name the row shows. */
  readonly WAITING: ReadonlyArray<{ readonly name: string; readonly short: string }>;
}

/**
 * Returns the `Crew` object that the book's crew.js sets on `window`. Fails
 * when crew.js has not run on this page: a reference page must load
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
 * Returns the face crew.js draws for `look` in `pose` at `size`, as an
 * element. crew.js returns a face only as a string of markup, so the face is
 * parsed from it. `name` is the face's accessible name.
 */
export function drawBookFace(name: string, look: Look, pose: string, size: number): Element {
  const template = document.createElement("template");
  template.innerHTML = readCrew().face(name, { pose, size, look: buildBookLook(look) });
  return template.content.firstElementChild!;
}

/**
 * Returns the provider mark crew.js draws for `name` ("claude" or "openai")
 * at `size` pixels, as an element. crew.js returns a mark only as a string of
 * markup, so the mark is parsed from it.
 */
export function drawBookBrand(name: string, size: number): Element {
  const template = document.createElement("template");
  template.innerHTML = readCrew().brand(name, size);
  return template.content.firstElementChild!;
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
 * Draws a workflow graph's pane the same way on every capture, on the book's
 * page and on the app's alike. Chromium draws two parts of the pane a little
 * differently from one capture to the next, so the same page failed by 30 to
 * 380 pixels at random, on the book's side as often as on the app's:
 *
 * - the fade at a cut edge, which is a CSS mask, so the pane loses it;
 * - a pane that scrolls, which Chromium draws on a layer of its own, so the
 *   pane stops scrolling. The graph stays where it opened, with no scroll
 *   bar.
 *
 * The compared parts still check that both pages cut the graph on the same
 * side, through the pane's `is-cut-left` and `is-cut-right` classes.
 */
export function stillGraphPane(): void {
  const style = document.createElement("style");
  style.textContent = ".graph-pane { mask-image: none !important; overflow: hidden !important; }";
  document.head.append(style);
}
