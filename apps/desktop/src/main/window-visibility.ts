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
 * route), and it reports once its fonts have loaded and, on macOS, its frame
 * has reached the window (on Linux, once the screen is laid out and drawn;
 * see `reportFirstScreen`). That 1 second starts late: only after the
 * renderer's code has compiled and the router's context has been read, while
 * this limit starts at the first paint. So the limit leaves room for a cold
 * launch on a slow Mac, and the timer shows the window only for a renderer
 * that never reports.
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
  on(event: "close", listener: (event: { preventDefault(): void }) => void): unknown;
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
  /**
   * What closing the window does when the app is not quitting: "hides" hides
   * it and keeps the app running, "quits" quits the app.
   */
  readonly closingWindow: "hides" | "quits";
  /** Quits the app, which closes the window. */
  readonly quitApp: () => void;
  /** Saves the window's state. */
  readonly saveWindowState: (state: WindowState) => void;
  /** Logs an error. */
  readonly logError: (message: string) => void;
}

/**
 * Takes over showing and hiding `window`, a window that is still hidden and
 * has not started loading its page, and returns the functions that do it.
 *
 * The window shows for the first time when its page reports its first
 * screen (see `showWindowFirstTime`), or 3 seconds after its page first
 * painted, whichever is first. It also shows at once when its page fails to
 * load or its renderer process exits, so that the wait is only the last
 * resort. Showing earlier would show an empty page, filled with the
 * background colour only.
 *
 * What the report means depends on the platform. On macOS the page reports
 * once the frame that draws its first screen has reached the window, because
 * Chromium presents frames in a hidden window there. On Linux under X11 a
 * hidden window presents no frame, so the page reports once the screen is
 * laid out and drawn, main shows the window, and the frame is presented after
 * the show (see `reportFirstScreen` in the renderer's `presented-frame.ts`).
 *
 * Closing the window, with the system's close button or a shortcut, hides
 * it or quits the app, as `closingWindow` says. Quitting the app closes the
 * window either way.
 *
 * It saves the window's state when closing hides the window and when the app
 * quits, never while the window moves or resizes.
 */
export const makeWindowVisibility = (
  window: ShowableWindow,
  { restoreFullScreen, closingWindow, quitApp, saveWindowState, logError }: WindowVisibilityOptions,
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
  // True once the app is quitting, so that closing the window lets it close.
  let quitting = false;
  // The timer that shows the window if its page never reports its first
  // screen. It starts when the page first paints.
  let firstScreenTimeout: ReturnType<typeof setTimeout> | undefined;

  const measureWindowState = (): WindowState =>
    window.isFullScreen()
      ? { bounds: normalBounds, fullScreen: true }
      : { bounds: window.getNormalBounds(), fullScreen: false };

  const hideAfterLeavingFullScreen = () => window.hide();

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
  const hideWindow = (): void => {
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
  };

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
  // Closing is always stopped here, and the window closes only once the app
  // quits. A quit that the close starts saves the window's state first
  // (see `prepareToQuit`), while the window still exists to be measured, and
  // then closes the window, which this handler lets through.
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    if (closingWindow === "hides") hideWindow();
    else quitApp();
  });
  // A window that closes before the timer fires is gone, and showing it then
  // would throw.
  window.once("closed", () => clearTimeout(firstScreenTimeout));

  return {
    /**
     * Shows the window the first time, as the page asks when it reports its
     * first screen (on macOS, once that screen has reached the window; on
     * Linux, before it has). Once the window has shown, it does nothing: the
     * page reports again after each reload, and the "connecting" screen
     * reports too.
     */
    showWindowFirstTime,

    /**
     * Shows the window and focuses it. Before the first show it does
     * nothing, because the window shows itself when its page reports its
     * first screen.
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
     * Lets the window close, and saves its state while it still has one. Call
     * it when the app starts to quit, before Electron closes the window. The
     * flag is set here, not in an effect, because Electron closes the window
     * right after the quit starts.
     *
     * Only the first call does anything. Electron can emit `before-quit`
     * again after the window is gone, when a close that quits the app starts
     * a second quit, and measuring a destroyed window throws.
     *
     * The state is saved only when the window is on screen. A window that is
     * not on screen is not saved again: one that closing hid was saved then,
     * and one that has not shown yet has nothing new to save. Saving either
     * now would lose a full screen that the saved state holds.
     */
    prepareToQuit: (): void => {
      if (quitting) return;
      quitting = true;
      if (shownOnce && !hiddenByClosing) saveWindowState(measureWindowState());
    },
  };
};
