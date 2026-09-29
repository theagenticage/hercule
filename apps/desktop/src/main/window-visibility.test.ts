import { describe, expect, it } from "vitest";
import type { Bounds, WindowState } from "./app-settings";
import { makeWindowVisibility, type ShowableWindow } from "./window-visibility";

/** Where the stand-in window is created. */
const CREATED_AT: Bounds = { x: 40, y: 60, width: 1440, height: 900 };
/** Where the user moves it. */
const MOVED_TO: Bounds = { x: 200, y: 100, width: 1200, height: 800 };

/**
 * A stand-in for the window. It records each call that shows, hides or
 * focuses the window, or changes its full screen, and each save, in `calls`.
 *
 * Like Electron's, its normal bounds are stale in full screen: they are the
 * bounds it was created at, whatever the user did since. Entering and leaving
 * full screen take an animation, so each ends only when the test calls
 * `finishEnteringFullScreen` or `finishLeavingFullScreen`.
 */
const makeWindow = () => {
  const calls: Array<string> = [];
  const saved: Array<WindowState> = [];
  const listeners: Array<{ event: string; listener: () => void; once: boolean }> = [];
  const emit = (event: string) => {
    for (const entry of listeners.filter((entry) => entry.event === event)) {
      if (entry.once) listeners.splice(listeners.indexOf(entry), 1);
      entry.listener();
    }
  };
  let fullScreen = false;
  let bounds = CREATED_AT;

  const window: ShowableWindow = {
    show: () => calls.push("show"),
    hide: () => calls.push("hide"),
    focus: () => calls.push("focus"),
    isFullScreen: () => fullScreen,
    setFullScreen: (flag) => calls.push(`setFullScreen(${String(flag)})`),
    getNormalBounds: () => (fullScreen ? CREATED_AT : bounds),
    on: (event, listener) => listeners.push({ event, listener, once: false }),
    once: (event, listener) => listeners.push({ event, listener, once: true }),
    off: (event, listener) => {
      const index = listeners.findIndex(
        (entry) => entry.event === event && entry.listener === listener,
      );
      if (index !== -1) listeners.splice(index, 1);
    },
  };
  const saveWindowState = (state: WindowState) => {
    calls.push("save");
    saved.push(state);
  };

  return {
    window,
    calls,
    saved,
    saveWindowState,
    /** Moves the window, as the user does by dragging it. */
    moveTo: (next: Bounds) => {
      bounds = next;
      emit("moved");
    },
    /** Ends the animation into full screen, which resizes the window. */
    finishEnteringFullScreen: () => {
      fullScreen = true;
      emit("resized");
    },
    /** Ends the animation out of full screen. */
    finishLeavingFullScreen: () => {
      fullScreen = false;
      emit("resized");
      emit("leave-full-screen");
    },
  };
};

/** Makes a stand-in window, and a visibility for it that has shown the window. */
const makeShownWindow = () => {
  const stand = makeWindow();
  const visibility = makeWindowVisibility(stand.window, stand.saveWindowState);
  visibility.showWindowFirstTime(false);
  stand.calls.length = 0;
  return { ...stand, visibility };
};

describe("showWindowFirstTime", () => {
  it("shows the window", () => {
    const { window, calls, saveWindowState } = makeWindow();
    makeWindowVisibility(window, saveWindowState).showWindowFirstTime(false);
    expect(calls).toEqual(["show"]);
  });

  it("puts a window saved in full screen back in full screen, once it is on screen", () => {
    const { window, calls, saveWindowState } = makeWindow();
    makeWindowVisibility(window, saveWindowState).showWindowFirstTime(true);
    expect(calls).toEqual(["show", "setFullScreen(true)"]);
  });
});

describe("showWindow", () => {
  it("does nothing before the window has shown the first time", () => {
    const { window, calls, saveWindowState } = makeWindow();
    makeWindowVisibility(window, saveWindowState).showWindow();
    expect(calls).toEqual([]);
  });

  it("shows and focuses the window", () => {
    const { visibility, calls } = makeShownWindow();
    visibility.showWindow();
    expect(calls).toEqual(["show", "focus"]);
  });
});

describe("hideWindow", () => {
  it("saves a window that is not in full screen and hides it", () => {
    const { visibility, calls, saved, moveTo } = makeShownWindow();
    moveTo(MOVED_TO);
    visibility.hideWindow();
    expect(calls).toEqual(["save", "hide"]);
    expect(saved).toEqual([{ bounds: MOVED_TO, fullScreen: false }]);
  });

  it("saves a window in full screen as full screen, at the bounds it last had outside it, and hides it once out of full screen", () => {
    const { visibility, calls, saved, moveTo, finishEnteringFullScreen, finishLeavingFullScreen } =
      makeShownWindow();
    moveTo(MOVED_TO);
    finishEnteringFullScreen();

    visibility.hideWindow();
    expect(calls).toEqual(["save", "setFullScreen(false)"]);
    expect(saved).toEqual([{ bounds: MOVED_TO, fullScreen: true }]);

    finishLeavingFullScreen();
    expect(calls).toEqual(["save", "setFullScreen(false)", "hide"]);
  });

  it("keeps a window shown again while it leaves full screen on screen", () => {
    const { visibility, calls, finishEnteringFullScreen, finishLeavingFullScreen } =
      makeShownWindow();
    finishEnteringFullScreen();

    visibility.hideWindow();
    visibility.showWindow();
    finishLeavingFullScreen();
    expect(calls).toEqual(["save", "setFullScreen(false)", "show", "focus"]);
  });

  it("keeps a window closed twice and shown again while it leaves full screen on screen", () => {
    const { visibility, calls, finishEnteringFullScreen, finishLeavingFullScreen } =
      makeShownWindow();
    finishEnteringFullScreen();

    visibility.hideWindow();
    visibility.hideWindow();
    visibility.showWindow();
    finishLeavingFullScreen();
    expect(calls).not.toContain("hide");
  });
});

describe("saveWindowStateOnQuit", () => {
  it("saves a window in full screen as full screen, at the bounds it last had outside it", () => {
    const { visibility, saved, moveTo, finishEnteringFullScreen } = makeShownWindow();
    moveTo(MOVED_TO);
    finishEnteringFullScreen();

    visibility.saveWindowStateOnQuit();
    expect(saved).toEqual([{ bounds: MOVED_TO, fullScreen: true }]);
  });

  it("saves nothing before the window has shown the first time", () => {
    const { window, saved, saveWindowState } = makeWindow();
    makeWindowVisibility(window, saveWindowState).saveWindowStateOnQuit();
    expect(saved).toEqual([]);
  });

  it("keeps the full screen saved when closing hid the window", () => {
    const { visibility, saved, finishEnteringFullScreen, finishLeavingFullScreen } =
      makeShownWindow();
    finishEnteringFullScreen();
    visibility.hideWindow();
    finishLeavingFullScreen();

    visibility.saveWindowStateOnQuit();
    expect(saved).toEqual([{ bounds: CREATED_AT, fullScreen: true }]);
  });

  it("saves again once the window is shown again", () => {
    const { visibility, saved, moveTo } = makeShownWindow();
    visibility.hideWindow();
    visibility.showWindow();
    moveTo(MOVED_TO);

    visibility.saveWindowStateOnQuit();
    expect(saved).toEqual([
      { bounds: CREATED_AT, fullScreen: false },
      { bounds: MOVED_TO, fullScreen: false },
    ]);
  });
});
