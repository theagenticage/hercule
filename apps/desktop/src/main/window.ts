/**
 * The app's one window, the MainWindow service (see `./main-window.ts`), built
 * with Electron: how it opens, shows, hides and remembers where it was.
 *
 * - It opens hidden, painted with the theme's background, and shows once its
 *   first screen has reached it, so it never shows an empty page (see
 *   `./window-visibility.ts`).
 * - It opens where it was when the app last hid it or quit, moved onto a
 *   display when that position is on none. The first time, it opens at
 *   1440 by 900, centred.
 * - Closing it hides it; the app keeps running. Quitting closes it.
 * - Its state is saved when closing hides it and when the app quits, never
 *   while it moves or resizes.
 */
import path from "node:path";
import { app, BrowserWindow, dialog, nativeTheme, screen, type Event } from "electron";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import { AppSettings, type Bounds, type WindowState } from "./app-settings";
import { encodeIpcPayload } from "./ipc/payload";
import { MainWindow } from "./main-window";
import { RENDERER_URL } from "./renderer-origin";
import { chooseWindowBackground } from "./window-background";
import {
  buildDefaultWindowBounds,
  MINIMUM_WINDOW_SIZE,
  placeWindowOnDisplays,
} from "./window-placement";
import { makeWindowVisibility } from "./window-visibility";

/**
 * Where macOS draws the traffic lights: the top-left corner of the first
 * light, from the window's top-left corner, in points. It puts their centres
 * at (26, 24), (46, 24) and (66, 24), where the Bureau frame draws them.
 */
const TRAFFIC_LIGHT_POSITION = { x: 19, y: 16 };

/**
 * Returns where the window opens: where it was saved, moved onto a display if
 * it is on none, or centred on the main display the first time.
 */
const chooseWindowBounds = (saved: WindowState | null): Bounds =>
  saved === null
    ? buildDefaultWindowBounds(screen.getPrimaryDisplay().workArea)
    : placeWindowOnDisplays(saved.bounds, screen.getAllDisplays());

/**
 * Creates the window, hidden, and wires its events. The window shows itself
 * once its first screen has reached it.
 *
 * The window and the listeners on the app are released when main's runtime
 * shuts down: the listeners are removed, and the window is destroyed if it
 * is still open.
 */
const make = Effect.gen(function* () {
  // Electron creates no window before it is ready, and an `activate` or
  // `second-instance` event can build this layer before then.
  yield* Effect.promise(() => app.whenReady());
  const settings = yield* AppSettings;
  const saved = yield* settings.readWindowState;

  // Electron's events start effects that run in the background: saves and
  // logs. When main shuts down, it waits for those under way instead of
  // interrupting them, so the save the app starts as it quits reaches the
  // disk. The finalizer added last runs first, so the wait comes before the
  // set of fibers is closed.
  const background = yield* FiberSet.make();
  yield* Effect.addFinalizer(() => FiberSet.awaitEmpty(background));
  const runInBackground = yield* FiberSet.runtime(background)();
  const startSavingWindowState = (state: WindowState): void => {
    runInBackground(
      settings
        .saveWindowState(state)
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning(`Could not save the window's state: ${error.message}`),
          ),
        ),
    );
  };

  // With `hiddenInset`, the page fills the whole window, title bar included,
  // so the window's bounds are also the page's.
  const window = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new BrowserWindow({
          ...chooseWindowBounds(saved),
          minWidth: MINIMUM_WINDOW_SIZE.width,
          minHeight: MINIMUM_WINDOW_SIZE.height,
          show: false,
          backgroundColor: chooseWindowBackground(nativeTheme.shouldUseDarkColors),
          titleBarStyle: "hiddenInset",
          trafficLightPosition: TRAFFIC_LIGHT_POSITION,
          webPreferences: {
            preload: path.join(import.meta.dirname, "../preload/index.cjs"),
            sandbox: true,
            contextIsolation: true,
          },
        }),
    ),
    // When the app quits, Electron has closed the window before main shuts
    // down.
    (window) => Effect.sync(() => (window.isDestroyed() ? undefined : window.destroy())),
  );

  // A hidden window is not the key window, so Chromium gives its page no
  // focus, and the input a first screen focuses would draw its focus ring and
  // caret only once the window shows, a frame after the rest of the screen.
  // Focusing the page while the window is still hidden draws them with the
  // rest. Focus given before the page's navigation commits is lost with the
  // window's first, empty document, so it is given then, still before the
  // first paint.
  window.webContents.once("did-navigate", () => window.webContents.focus());

  const visibility = makeWindowVisibility(window, {
    restoreFullScreen: saved?.fullScreen ?? false,
    saveWindowState: startSavingWindowState,
    logError: (message) => {
      runInBackground(Effect.logError(message));
    },
  });
  let quitting = false;

  /** Hides the window instead of closing it, unless the app is quitting. */
  const hideInsteadOfClosing = (event: Event) => {
    if (quitting) return;
    event.preventDefault();
    visibility.hideWindow();
  };

  /**
   * Lets the window close, and saves its state while it still has one. The
   * flag is set here, not in an effect, because Electron closes the window
   * right after this event.
   */
  const prepareToQuit = () => {
    quitting = true;
    visibility.saveWindowStateOnQuit();
  };

  const paintBackground = () =>
    window.setBackgroundColor(chooseWindowBackground(nativeTheme.shouldUseDarkColors));

  window.on("close", hideInsteadOfClosing);
  // After the window has closed, macOS can still report a change to it, such
  // as the window being hidden, and Electron still emits the event on the
  // destroyed window. A listener that reads the window then throws "Object
  // has been destroyed". Electron's own listener for `show` and `hide` does
  // that, and the error dialog that follows keeps the app from quitting
  // until the user dismisses it. The window is gone, so no listener on it
  // has anything left to do. The other listeners for `closed` still run:
  // Node calls every listener an event had when it was emitted.
  window.once("closed", () => window.removeAllListeners());
  yield* Effect.acquireRelease(
    Effect.sync(() => nativeTheme.on("updated", paintBackground)),
    () => Effect.sync(() => nativeTheme.off("updated", paintBackground)),
  );
  yield* Effect.acquireRelease(
    Effect.sync(() => app.on("before-quit", prepareToQuit)),
    () => Effect.sync(() => app.off("before-quit", prepareToQuit)),
  );

  return MainWindow.of({
    load: Effect.tryPromise(() => window.loadURL(RENDERER_URL)).pipe(
      Effect.catch((error) =>
        Effect.logError(`The window could not load ${RENDERER_URL}: ${error.message}`),
      ),
    ),
    reload: Effect.sync(() => window.webContents.reload()),
    show: Effect.sync(visibility.showWindow),
    showFirstTime: Effect.sync(visibility.showWindowFirstTime),
    send: (name, payload) =>
      Effect.map(encodeIpcPayload(name, payload), (encoded) =>
        window.webContents.send(name, encoded),
      ),
    showWarning: (message) =>
      Effect.sync(() => {
        void dialog.showMessageBox(window, { type: "warning", message, buttons: ["OK"] });
      }),
  });
});

/** Builds the window service; see `make`. */
export const MainWindowLayer: Layer.Layer<MainWindow, never, AppSettings> =
  Layer.effect(MainWindow)(make);
