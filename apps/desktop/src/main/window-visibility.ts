/**
 * When the window shows and hides, and which of its states is saved when.
 *
 * This module imports only types, so unit tests can drive it with a stand-in
 * for the window, without Electron.
 */
import type { Bounds, WindowState } from "./app-settings";

/** The parts of Electron's `BrowserWindow` that showing and hiding use. */
export interface ShowableWindow {
  show(): void;
  hide(): void;
  focus(): void;
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
  getNormalBounds(): Bounds;
  on(event: "moved" | "resized", listener: () => void): unknown;
  once(event: "leave-full-screen", listener: () => void): unknown;
  off(event: "leave-full-screen", listener: () => void): unknown;
}

/**
 * Takes over showing and hiding `window`, a window that is still hidden, and
 * returns the functions that do it. Each state to save is passed to
 * `saveWindowState`.
 *
 * It saves the window's state when closing hides the window and when the app
 * quits, never while the window moves or resizes.
 */
export const makeWindowVisibility = (
  window: ShowableWindow,
  saveWindowState: (state: WindowState) => void,
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

  // False until the page has drawn and the window has shown the first time.
  let shownOnce = false;
  // True while closing has hidden the window, until it shows again.
  let hiddenByClosing = false;

  const measureWindowState = (): WindowState =>
    window.isFullScreen()
      ? { bounds: normalBounds, fullScreen: true }
      : { bounds: window.getNormalBounds(), fullScreen: false };

  const hideAfterLeavingFullScreen = () => window.hide();

  return {
    /**
     * Shows the window the first time, once its page has drawn. When
     * `fullScreen` is true, the window was in full screen when its state was
     * saved, and it goes back to full screen.
     *
     * The window enters full screen only once it is on screen, the way a
     * user takes a window to full screen, so its page has drawn before the
     * animation starts.
     */
    showWindowFirstTime: (fullScreen: boolean): void => {
      shownOnce = true;
      window.show();
      if (fullScreen) window.setFullScreen(true);
    },

    /**
     * Shows the window and focuses it. Before the first show it does
     * nothing, because the window shows itself once its page has drawn.
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
