/**
 * When the window shows and hides, and which of its states is saved when.
 *
 * This module imports only types, so unit tests can drive it with a stand-in
 * for the window, without Electron.
 */
import type { Bounds, WindowState } from "./app-settings";

/**
 * How long the window waits for its first screen, from the moment its page
 * first painted, before it shows anyway.
 *
 * A healthy page always reports before this limit. When the controller is
 * slow, the "connecting" screen reports instead: the router shows it 1 second
 * after the first navigation starts (the `pendingMs` of the `_connected`
 * route), and it reports once its fonts have loaded and its frame has reached
 * the window. That 1 second starts late: only after the renderer's code has
 * compiled and the router's context has been read, while this limit starts at
 * the first paint. So the limit leaves room for a cold launch on a slow Mac,
 * and the timer shows the window only for a renderer that never reports.
 *
 * A crash or a failed load shows the window at once, so the longer limit
 * costs nothing there.
 */
export const FIRST_SCREEN_TIMEOUT_MS = 3000;

/**
 * The opening words of the error logged when the window is shown without its
 * first screen; the reason follows them. It is an error, not a warning: a
 * healthy launch never shows the window this way, and the launch tests and
 * the perf script fail when they find it in main's output.
 */
export const SHOWN_WITHOUT_FIRST_SCREEN_ERROR =
  "The window is shown without waiting for its first screen";

/** Chromium's error code for a load that was cancelled rather than failed. */
const ERR_ABORTED = -3;

/** The parts of Electron's `BrowserWindow` that showing and hiding use. */
export interface ShowableWindow {
  show(): void;
  hide(): void;
  focus(): void;
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
  getNormalBounds(): Bounds;
  on(event: "moved" | "resized", listener: () => void): unknown;
  once(event: "ready-to-show" | "closed" | "leave-full-screen", listener: () => void): unknown;
  off(event: "leave-full-screen", listener: () => void): unknown;
  readonly webContents: {
    on(
      event: "did-fail-load",
      listener: (
        event: unknown,
        errorCode: number,
        errorDescription: string,
        validatedURL: string,
        isMainFrame: boolean,
      ) => void,
    ): unknown;
    once(
      event: "render-process-gone",
      listener: (event: unknown, details: { readonly reason: string }) => void,
    ): unknown;
  };
}

/** What `makeWindowVisibility` needs besides the window. */
export interface WindowVisibilityOptions {
  /**
   * True when the window was in full screen when its state was saved. It
   * goes back to full screen when it first shows.
   */
  readonly restoreFullScreen: boolean;
  /** Saves the window's state. */
  readonly saveWindowState: (state: WindowState) => void;
  /** Logs an error. */
  readonly logError: (message: string) => void;
}

/**
 * Takes over showing and hiding `window`, a window that is still hidden and
 * has not started loading its page, and returns the functions that do it.
 *
 * The window shows for the first time when its page reports that its first
 * screen has reached the window (see `showWindowFirstTime`), or 3 seconds
 * after its page first painted, whichever is first. It also shows at once when its page
 * fails to load or its renderer process exits, so that the wait is only the
 * last resort. Showing earlier would show an empty page, filled with the
 * background colour only.
 *
 * It saves the window's state when closing hides the window and when the app
 * quits, never while the window moves or resizes.
 */
export const makeWindowVisibility = (
  window: ShowableWindow,
  { restoreFullScreen, saveWindowState, logError }: WindowVisibilityOptions,
) => {
  // In full screen, Electron's normal bounds are the bounds it last set
  // itself, and miss any move or resize the user made before. So the bounds
  // are kept here each time the window moves or resizes outside full screen.
  let normalBounds = window.getNormalBounds();
  const keepNormalBounds = () => {
    if (!window.isFullScreen()) normalBounds = window.getNormalBounds();
  };
  window.on("moved", keepNormalBounds);
  window.on("resized", keepNormalBounds);

  // False until the window has shown the first time.
  let shownOnce = false;
  // True while closing has hidden the window, until it shows again.
  let hiddenByClosing = false;
  // The timer that shows the window if its page never reports its first
  // screen. It starts when the page first paints.
  let firstScreenTimeout: ReturnType<typeof setTimeout> | undefined;

  const measureWindowState = (): WindowState =>
    window.isFullScreen()
      ? { bounds: normalBounds, fullScreen: true }
      : { bounds: window.getNormalBounds(), fullScreen: false };

  const hideAfterLeavingFullScreen = () => window.hide();

  /**
   * Shows the window the first time, and does nothing once it has shown.
   *
   * It marks the moment in main's performance timeline as `window-shown`,
   * which the launch measurement reads. A window saved in full screen goes
   * back to full screen only once it is on screen, the way a user takes a
   * window to full screen, so its page has drawn before the animation starts.
   */
  const showWindowFirstTime = (): void => {
    if (shownOnce) return;
    shownOnce = true;
    clearTimeout(firstScreenTimeout);
    window.show();
    performance.mark("window-shown");
    if (restoreFullScreen) window.setFullScreen(true);
  };

  /** Shows the window the first time, and logs why its first screen was not waited for. */
  const showWindowWithoutFirstScreen = (reason: string): void => {
    if (shownOnce) return;
    logError(`${SHOWN_WITHOUT_FIRST_SCREEN_ERROR}, because ${reason}.`);
    showWindowFirstTime();
  };

  window.once("ready-to-show", () => {
    firstScreenTimeout = setTimeout(() => {
      showWindowWithoutFirstScreen(
        `the page did not report its first screen within ${String(FIRST_SCREEN_TIMEOUT_MS)} ms of its first paint`,
      );
    }, FIRST_SCREEN_TIMEOUT_MS);
  });
  // Electron also reports failures that leave the page in place. They are
  // ignored, and the listener stays for a later failure of the page itself:
  // - a subframe that fails to load;
  // - ERR_ABORTED (-3), which Electron reports for a page whose load was
  //   stopped after the page committed, by `webContents.stop()` or
  //   `window.stop()`, and for a `loadURL` that the page's `beforeunload`
  //   handler cancelled. A navigation cancelled before it commits is not
  //   reported here at all.
  window.webContents.on("did-fail-load", (_event, errorCode, _description, _url, isMainFrame) => {
    if (!isMainFrame || errorCode === ERR_ABORTED) return;
    showWindowWithoutFirstScreen("its page failed to load");
  });
  window.webContents.once("render-process-gone", (_event, details) => {
    showWindowWithoutFirstScreen(`its renderer process exited (${details.reason})`);
  });
  // A window that closes before the timer fires is gone, and showing it then
  // would throw.
  window.once("closed", () => clearTimeout(firstScreenTimeout));

  return {
    /**
     * Shows the window the first time, as the page asks once its first
     * screen has reached the window. Once the window has shown, it does
     * nothing: the page reports again after each reload, and the
     * "connecting" screen reports too.
     */
    showWindowFirstTime,

    /**
     * Shows the window and focuses it. Before the first show it does
     * nothing, because the window shows itself once its first screen has
     * reached it.
     *
     * A window that closing is still taking out of full screen stays on
     * screen: the hide waiting for the end of the animation is cancelled.
     */
    showWindow: (): void => {
      if (!shownOnce) return;
      hiddenByClosing = false;
      window.off("leave-full-screen", hideAfterLeavingFullScreen);
      window.show();
      window.focus();
    },

    /**
     * Hides the window, as closing it does, and saves its state.
     *
     * A window in full screen is saved as full screen, so it returns to full
     * screen at the next launch. It leaves full screen before it hides:
     * hidden while in full screen, it would leave an empty black space
     * behind.
     *
     * The state is saved here, not on the window's `hide` event. On macOS,
     * Electron emits `hide` when the window stops being visible on screen:
     * it fires when other windows cover this one, and it does not fire when
     * a window that is already covered hides.
     */
    hideWindow: (): void => {
      hiddenByClosing = true;
      saveWindowState(measureWindowState());
      if (!window.isFullScreen()) {
        window.hide();
        return;
      }
      // Closing twice during the animation still leaves one hide waiting,
      // so that showing the window cancels it.
      window.off("leave-full-screen", hideAfterLeavingFullScreen);
      window.once("leave-full-screen", hideAfterLeavingFullScreen);
      window.setFullScreen(false);
    },

    /**
     * Saves the window's state as the app quits, when the window is on
     * screen. A window that is not on screen is not saved again: one that
     * closing hid was saved then, and one that has not shown yet has nothing
     * new to save. Saving either now would lose a full screen that the
     * saved state holds.
     */
    saveWindowStateOnQuit: (): void => {
      if (shownOnce && !hiddenByClosing) saveWindowState(measureWindowState());
    },
  };
};
