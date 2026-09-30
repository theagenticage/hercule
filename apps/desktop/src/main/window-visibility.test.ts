import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bounds, WindowState } from "./app-settings";
import {
  FIRST_SCREEN_TIMEOUT_MS,
  makeWindowVisibility,
  SHOWN_WITHOUT_FIRST_SCREEN_ERROR,
  type ShowableWindow,
} from "./window-visibility";

/** Where the stand-in window is created. */
const CREATED_AT: Bounds = { x: 40, y: 60, width: 1440, height: 900 };
/** Where the user moves it. */
const MOVED_TO: Bounds = { x: 200, y: 100, width: 1200, height: 800 };

/**
 * The arguments after the event of a `did-fail-load` for the page itself:
 * the error code, its description, the URL, and whether the main frame
 * failed.
 */
const PAGE_FAILED_TO_LOAD = [-6, "ERR_FILE_NOT_FOUND", "app://hercule/", true] as const;

/**
 * A stand-in for the window. It records each call that shows, hides or
 * focuses the window, or changes its full screen, each save and each error,
 * in `calls`.
 *
 * Like Electron's, its normal bounds are stale in full screen: they are the
 * bounds it was created at, whatever the user did since. Entering and leaving
 * full screen take an animation, so each ends only when the test calls
 * `finishEnteringFullScreen` or `finishLeavingFullScreen`.
 */
const makeWindow = () => {
  const calls: Array<string> = [];
  const saved: Array<WindowState> = [];
  const errors: Array<string> = [];
  // The listeners take the arguments Electron passes after the event, each
  // typed by the interface the stand-in fills.
  type Listener = (event: unknown, ...args: Array<never>) => void;
  const listeners: Array<{ event: string; listener: Listener; once: boolean }> = [];
  const emit = (event: string, ...args: ReadonlyArray<unknown>) => {
    for (const entry of listeners.filter((entry) => entry.event === event)) {
      if (entry.once) listeners.splice(listeners.indexOf(entry), 1);
      entry.listener({}, ...(args as Array<never>));
    }
  };
  const on = (event: string, listener: Listener) =>
    listeners.push({ event, listener, once: false });
  const once = (event: string, listener: Listener) =>
    listeners.push({ event, listener, once: true });
  let fullScreen = false;
  let bounds = CREATED_AT;

  const window: ShowableWindow = {
    show: () => calls.push("show"),
    hide: () => calls.push("hide"),
    focus: () => calls.push("focus"),
    isFullScreen: () => fullScreen,
    setFullScreen: (flag) => calls.push(`setFullScreen(${String(flag)})`),
    getNormalBounds: () => (fullScreen ? CREATED_AT : bounds),
    on,
    once,
    off: (event, listener) => {
      const index = listeners.findIndex(
        (entry) => entry.event === event && entry.listener === listener,
      );
      if (index !== -1) listeners.splice(index, 1);
    },
    webContents: { on, once },
  };
  const saveWindowState = (state: WindowState) => {
    calls.push("save");
    saved.push(state);
  };
  const logError = (message: string) => {
    calls.push("error");
    errors.push(message);
  };

  return {
    calls,
    saved,
    errors,
    /** Takes over showing and hiding the stand-in, for a window saved in full screen or not. */
    makeVisibility: ({ restoreFullScreen = false } = {}) =>
      makeWindowVisibility(window, { restoreFullScreen, saveWindowState, logError }),
    /** Emits `event`, as Electron does on the window or its web contents. */
    emit,
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
  const visibility = stand.makeVisibility();
  visibility.showWindowFirstTime();
  stand.calls.length = 0;
  return { ...stand, visibility };
};

beforeEach(() => {
  // Only the timers are faked: a fake `performance` would drop the marks.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(() => {
  vi.useRealTimers();
  performance.clearMarks("window-shown");
});

describe("the first show", () => {
  it("shows the window when the page reports its first screen, and not before", () => {
    const { calls, makeVisibility, emit } = makeWindow();
    const visibility = makeVisibility();
    emit("ready-to-show");
    expect(calls).toEqual([]);

    visibility.showWindowFirstTime();
    expect(calls).toEqual(["show"]);
  });

  it("marks the moment the window shows, for the launch measurement", () => {
    const { makeVisibility } = makeWindow();
    makeVisibility().showWindowFirstTime();
    expect(performance.getEntriesByName("window-shown")).toHaveLength(1);
  });

  it("shows the window only once, however many times the page reports", () => {
    const { calls, makeVisibility, emit } = makeWindow();
    const visibility = makeVisibility();
    emit("ready-to-show");
    visibility.showWindowFirstTime();
    visibility.showWindowFirstTime();
    vi.advanceTimersByTime(FIRST_SCREEN_TIMEOUT_MS);
    emit("did-fail-load", ...PAGE_FAILED_TO_LOAD);
    emit("render-process-gone", { reason: "crashed" });

    expect(calls).toEqual(["show"]);
    expect(performance.getEntriesByName("window-shown")).toHaveLength(1);
  });

  it("shows the window 3 seconds after the page first painted, when the page never reports, and logs why", () => {
    const { calls, errors, makeVisibility, emit } = makeWindow();
    makeVisibility();
    emit("ready-to-show");
    vi.advanceTimersByTime(FIRST_SCREEN_TIMEOUT_MS - 1);
    expect(calls).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(calls).toEqual(["error", "show"]);
    expect(errors).toEqual([
      "The window is shown without waiting for its first screen, because the page did not report its first screen within 3000 ms of its first paint.",
    ]);
    expect(errors[0]!.startsWith(SHOWN_WITHOUT_FIRST_SCREEN_ERROR)).toBe(true);
  });

  it("waits for the page to first paint before it starts the 3 seconds", () => {
    const { calls, makeVisibility } = makeWindow();
    makeVisibility();
    vi.advanceTimersByTime(10 * FIRST_SCREEN_TIMEOUT_MS);
    expect(calls).toEqual([]);
  });

  it("shows the window at once when its page fails to load, and logs why", () => {
    const { calls, errors, makeVisibility, emit } = makeWindow();
    makeVisibility();
    emit("did-fail-load", ...PAGE_FAILED_TO_LOAD);
    expect(calls).toEqual(["error", "show"]);
    expect(errors).toEqual([
      "The window is shown without waiting for its first screen, because its page failed to load.",
    ]);
  });

  it("keeps the window hidden when a frame inside the page fails to load, and still shows it when the page fails later", () => {
    const { calls, makeVisibility, emit } = makeWindow();
    makeVisibility();
    emit("did-fail-load", -105, "ERR_NAME_NOT_RESOLVED", "https://example.invalid/", false);
    expect(calls).toEqual([]);

    emit("did-fail-load", ...PAGE_FAILED_TO_LOAD);
    expect(calls).toEqual(["error", "show"]);
  });

  it("keeps the window hidden when the page's load is stopped after the page committed", () => {
    const { calls, makeVisibility, emit } = makeWindow();
    makeVisibility();
    emit("did-fail-load", -3, "ERR_ABORTED", "app://hercule/", true);
    expect(calls).toEqual([]);
  });

  it("shows the window at once when its renderer process exits, and logs why", () => {
    const { calls, errors, makeVisibility, emit } = makeWindow();
    makeVisibility();
    emit("ready-to-show");
    emit("render-process-gone", { reason: "crashed" });
    expect(calls).toEqual(["error", "show"]);
    expect(errors).toEqual([
      "The window is shown without waiting for its first screen, because its renderer process exited (crashed).",
    ]);
  });

  it("never shows a window that closed before the 3 seconds passed", () => {
    const { calls, makeVisibility, emit } = makeWindow();
    makeVisibility();
    emit("ready-to-show");
    emit("closed");
    vi.advanceTimersByTime(FIRST_SCREEN_TIMEOUT_MS);
    expect(calls).toEqual([]);
  });

  it("puts a window saved in full screen back in full screen, once it is on screen", () => {
    const { calls, makeVisibility } = makeWindow();
    makeVisibility({ restoreFullScreen: true }).showWindowFirstTime();
    expect(calls).toEqual(["show", "setFullScreen(true)"]);
  });
});

describe("showWindow", () => {
  it("does nothing before the window has shown the first time", () => {
    const { calls, makeVisibility } = makeWindow();
    makeVisibility().showWindow();
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
    const { saved, makeVisibility } = makeWindow();
    makeVisibility().saveWindowStateOnQuit();
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
