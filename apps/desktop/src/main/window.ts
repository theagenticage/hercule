/**
 * The app's one window: how it opens, shows, hides and remembers where it was.
 *
 * - It opens hidden, painted with the theme's background, and shows once the
 *   page has drawn, so it never flashes a blank frame.
 * - It opens where it was when the app last hid it or quit, moved onto a
 *   display when that position is on none. The first time, it opens at
 *   1440 by 900, centred.
 * - Closing it hides it; the app keeps running. Quitting closes it.
 * - Its state is saved when closing hides it and when the app quits, never
 *   while it moves or resizes.
 */
import path from "node:path";
import { app, BrowserWindow, nativeTheme, screen, type Event } from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import { AppSettings, type Bounds, type WindowState } from "./app-settings";
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
 * once the page has drawn.
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

  // Saves run in the background, started by Electron's events. When main
  // shuts down, it waits for the saves under way instead of interrupting
  // them, so the save the app starts as it quits reaches the disk. The
  // finalizer added last runs first, so the wait comes before the set of
  // saves is closed.
  const saves = yield* FiberSet.make();
  yield* Effect.addFinalizer(() => FiberSet.awaitEmpty(saves));
  const runSave = yield* FiberSet.runtime(saves)();
  const startSavingWindowState = (state: WindowState): void => {
    runSave(
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

  const visibility = makeWindowVisibility(window, startSavingWindowState);
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

  window.once("ready-to-show", () => visibility.showWindowFirstTime(saved?.fullScreen ?? false));
  window.on("close", hideInsteadOfClosing);
  yield* Effect.acquireRelease(
    Effect.sync(() => nativeTheme.on("updated", paintBackground)),
    () => Effect.sync(() => nativeTheme.off("updated", paintBackground)),
  );
  yield* Effect.acquireRelease(
    Effect.sync(() => app.on("before-quit", prepareToQuit)),
    () => Effect.sync(() => app.off("before-quit", prepareToQuit)),
  );

  return {
    /**
     * Loads the renderer's page into the window. Call it once, after the
     * `app` scheme is served. A page that does not load is logged.
     */
    load: Effect.tryPromise(() => window.loadURL(RENDERER_URL)).pipe(
      Effect.catch((error) =>
        Effect.logError(`The window could not load ${RENDERER_URL}: ${error.message}`),
      ),
    ),

    /** Shows the window and focuses it; see `showWindow`. */
    show: Effect.sync(visibility.showWindow),
  };
});

/** The app's one window. */
export class MainWindow extends Context.Service<MainWindow, Effect.Success<typeof make>>()(
  "hercule/desktop/MainWindow",
) {}

/** Builds the window service; see `make`. */
export const MainWindowLayer: Layer.Layer<MainWindow, never, AppSettings> =
  Layer.effect(MainWindow)(make);

/** Loads the renderer's page into the window; see `MainWindow.load`. */
export const loadMainWindow: Effect.Effect<void, never, MainWindow> = MainWindow.use(
  (window) => window.load,
);

/** Shows and focuses the window; see `MainWindow.show`. */
export const showMainWindow: Effect.Effect<void, never, MainWindow> = MainWindow.use(
  (window) => window.show,
);
