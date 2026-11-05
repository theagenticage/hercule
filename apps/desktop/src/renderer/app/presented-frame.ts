/**
 * Waits until what the page shows is ready to be shown, and reports the first
 * screen to main then, so that main shows the window only once the window
 * already holds that screen. On macOS the page waits until the screen has
 * reached the window; on Linux it cannot, and waits until the screen is laid
 * out and drawn (see `reportFirstScreen`).
 */
import type { Bridge } from "../../ipc/bridge";

/**
 * The parts of an Element Timing entry that the wait reads. TypeScript's DOM
 * types have no such entry, because only Chromium implements Element Timing.
 */
interface ElementTimingEntry extends PerformanceEntry {
  /**
   * When the frame that painted the element was presented, or failed to
   * present, on the page's performance timeline.
   */
  readonly renderTime: DOMHighResTimeStamp;
  /** The element the entry is for, or null once it has left the document. */
  readonly element: Element | null;
}

/**
 * Waits until the frame that draws the screen on the page now, fonts
 * included, has been presented, or has failed to present. A presented frame
 * has reached the window. Returns when the frame was presented or failed, on
 * the page's performance timeline. Never returns if the page stops drawing
 * frames.
 *
 * It works in three steps:
 *
 * 1. It waits for the fonts. Chromium starts loading a font only when layout
 *    first needs it, and `document.fonts.ready` waits only for loads already
 *    started. Reading a size forces that layout first. Reading
 *    `document.fonts.ready` updates the layout too, but only when no font is
 *    loading at the time.
 * 2. It adds a sentinel to the page: an element Chromium times with Element
 *    Timing, and that draws nothing (see `createSentinel`). The next frame
 *    paints the sentinel, and also the whole screen, its fonts loaded.
 * 3. It waits for the sentinel's Element Timing entry, and removes the
 *    sentinel. Chromium delivers the entry once the frame that painted the
 *    sentinel has been presented, or has failed to present, and the entry's
 *    `renderTime` is that moment.
 *
 * A frame that fails to present never reaches the window, yet the wait ends
 * all the same. At launch, main then shows the window before it holds the
 * first screen, and the screen appears with the next frame that is
 * presented. Chromium rarely fails to present a frame, so such an early show
 * is rare.
 *
 * Animation frames cannot tell this. The second of two animation frames
 * runs once the first frame has been handed to the compositor, which can be
 * before that frame reaches the window.
 *
 * On macOS, Chromium draws and presents frames in a hidden window too, so
 * the wait ends there. On Linux under X11 it does not: a hidden window
 * presents no frame, and the wait would never end while main keeps the
 * window hidden until the page reports. `reportFirstScreen` therefore waits
 * differently on Linux; see `observePresentation`.
 */
export const waitForPresentedFrame = async (): Promise<DOMHighResTimeStamp> => {
  await waitForLayoutAndFonts();
  return observePresentation();
};

/**
 * Forces the page's layout, which makes Chromium start loading the fonts the
 * layout needs, then waits until every font is loaded. See step 1 of
 * `waitForPresentedFrame`.
 */
const waitForLayoutAndFonts = async (): Promise<void> => {
  document.documentElement.getBoundingClientRect();
  await document.fonts.ready;
};

/** Waits for `count` animation frames to run, one after the other. */
const waitForAnimationFrames = async (count: number): Promise<void> => {
  for (let frame = 0; frame < count; frame += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
};

/**
 * Adds the sentinel to the page and returns a promise of when the frame that
 * painted it was presented, or failed to present, on the page's performance
 * timeline. Removes the sentinel then. See steps 2 and 3 of
 * `waitForPresentedFrame`.
 *
 * The observer and the sentinel are in place when the function returns, so
 * the caller can do something else before it awaits the promise, such as
 * asking main to show the window.
 */
const observePresentation = (): Promise<DOMHighResTimeStamp> => {
  const sentinel = createSentinel();
  return new Promise<DOMHighResTimeStamp>((resolve) => {
    // The entry is picked by its element: two waits can run at once, and
    // each waits for its own sentinel.
    const observer = new PerformanceObserver((list) => {
      const entry = (list.getEntries() as Array<ElementTimingEntry>).find(
        (candidate) => candidate.element === sentinel,
      );
      if (entry === undefined) return;
      observer.disconnect();
      sentinel.remove();
      resolve(entry.renderTime);
    });
    // The observer is registered before the sentinel is added, so it
    // receives the entry without asking for buffered ones.
    observer.observe({ type: "element" });
    document.body.append(sentinel);
  });
};

/**
 * Creates the sentinel `waitForPresentedFrame` adds to the page: a span that
 * holds one no-break space, 1 pixel high, at the page's top-left corner.
 *
 * - A no-break space draws no pixel, in any colour, but Chromium still paints
 *   it as text and times it. The alternatives fail: Chromium gives no entry
 *   for text that is `transparent` or has `opacity: 0`, and a letter in the
 *   colour of the background under it still changed a pixel by one step of
 *   rounding.
 * - It is fixed, so it takes no room in the page's layout, and Chromium
 *   gives it a compositing layer of its own. Adding and removing it then
 *   repaints only that layer, not the page's own tiles. Positioned
 *   absolutely, it sat in the page's top tile, and removing it repainted
 *   that tile after the window had shown. The repainted tile can differ from
 *   the first by one step of colour, so the window's first frame was not the
 *   settled screen. The layer costs GPU memory only while the sentinel is in
 *   the page, about one frame, unlike the fixed drag strip (see `.drag-strip`
 *   in `shell.css`). It is added last, so no content painted after it overlaps
 *   it and gets a layer too.
 * - A system font needs no font to load.
 * - It is hidden from screen readers and lets the pointer through.
 *
 * Its style is set through `element.style`, which the page's content
 * security policy allows. The policy blocks a `style` attribute in the markup.
 */
const createSentinel = (): HTMLSpanElement => {
  const sentinel = document.createElement("span");
  sentinel.textContent = " ";
  sentinel.setAttribute("elementtiming", "presented-frame");
  sentinel.setAttribute("aria-hidden", "true");
  Object.assign(sentinel.style, {
    position: "fixed",
    top: "0",
    left: "0",
    font: "1px/1px sans-serif",
    pointerEvents: "none",
  });
  return sentinel;
};

/**
 * Reports the screen on the page now to main as the first screen, so that
 * main shows the window, and returns when a frame that draws it was
 * presented, or failed to present, on the page's performance timeline.
 * Main shows the window on the report at launch, and ignores it after.
 *
 * - On macOS, it reports once the frame has been presented (see
 *   `waitForPresentedFrame`).
 * - On Linux, it cannot wait for that: main keeps the window hidden until
 *   the report, and a hidden window presents no frame. It waits until the
 *   screen has its layout and its fonts, then starts observing presentation,
 *   reports, and only then waits for the presentation. The returned time is
 *   still that of a presented frame. Under X11 a hidden window draws, so
 *   before it reports the page also waits for two animation frames, which
 *   means the screen has been painted once. Under native Wayland a hidden
 *   window draws nothing and runs no animation frame (`Bridge.hiddenWindowDraws`
 *   is false), so the page does not wait for them, and the first frame the
 *   window draws is the first the page paints, from a layout that is already
 *   complete.
 *
 * Returns null when the wait or the report failed. A failure is logged, not
 * thrown: the page cannot do anything about it, and main's time limit then
 * shows the window instead.
 */
export const reportFirstScreen = async (bridge: Bridge): Promise<DOMHighResTimeStamp | null> => {
  try {
    if (bridge.platform === "linux") {
      await waitForLayoutAndFonts();
      if (bridge.hiddenWindowDraws) await waitForAnimationFrames(2);
      const presentation = observePresentation();
      await bridge.firstScreen.report();
      return await presentation;
    }
    const presentedAt = await waitForPresentedFrame();
    await bridge.firstScreen.report();
    return presentedAt;
  } catch (error) {
    console.error(
      "Could not report the first screen to main, so main's time limit will show the window instead:",
      error,
    );
    return null;
  }
};
