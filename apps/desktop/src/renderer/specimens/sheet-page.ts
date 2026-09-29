/**
 * What every captured sheet does the same way: take its theme from the URL,
 * hold a Bureau book page still, and tell the capture when it is ready.
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
 * Sets `data-ready` on `<html>` once the sheet can be captured: its fonts
 * have loaded and a frame that holds the whole sheet has been presented (see
 * `waitForPresentedFrame`). Call it after the sheet's cells are in the
 * document.
 *
 * The capture copies the latest frame the page has sent to the GPU process,
 * and a presented frame has been sent there; after two animation frames, the
 * sheet's frame may still be on its way.
 */
export async function markSheetReady(): Promise<void> {
  await waitForPresentedFrame();
  document.documentElement.dataset.ready = "";
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
