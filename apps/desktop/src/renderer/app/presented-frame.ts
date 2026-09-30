/**
 * Waits until what the page shows has reached the window, and reports the
 * first screen to main then, so that main shows the window only once the
 * window already holds that screen.
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
 * In a hidden window, Chromium still draws and presents frames, so the wait
 * ends there too.
 */
export const waitForPresentedFrame = async (): Promise<DOMHighResTimeStamp> => {
  document.documentElement.getBoundingClientRect();
  await document.fonts.ready;

  const sentinel = createSentinel();
  try {
    return await new Promise<DOMHighResTimeStamp>((resolve) => {
      // The entry is picked by its element: two waits can run at once, and
      // each waits for its own sentinel.
      const observer = new PerformanceObserver((list) => {
        const entry = (list.getEntries() as Array<ElementTimingEntry>).find(
          (candidate) => candidate.element === sentinel,
        );
        if (entry === undefined) return;
        observer.disconnect();
        resolve(entry.renderTime);
      });
      // The observer is registered before the sentinel is added, so it
      // receives the entry without asking for buffered ones.
      observer.observe({ type: "element" });
      document.body.append(sentinel);
    });
  } finally {
    sentinel.remove();
  }
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
 * Reports the screen on the page now to main as the first screen, once the
 * frame that draws it has been presented, or has failed to present (see
 * `waitForPresentedFrame`). Main shows the window on the report at launch,
 * and ignores it after.
 *
 * Returns when the frame was presented or failed, on the page's performance
 * timeline, or null when the wait or the report failed. A failure is logged,
 * not thrown: the page cannot do anything about it, and main's time limit
 * then shows the window instead.
 */
export const reportFirstScreen = async (bridge: Bridge): Promise<DOMHighResTimeStamp | null> => {
  try {
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
