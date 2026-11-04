/**
 * The app's one window, the MainWindow service (see `./main-window.ts`), built
 * with Electron: how it opens, shows, hides and remembers where it was.
 *
 * - It opens hidden, painted with the background of the theme in use, and
 *   shows once its page reports its first screen, so it never shows an empty
 *   page (see `./window-visibility.ts`). It repaints its background when the
 *   theme in use changes.
 * - It opens where it was when the app last hid it or quit, moved onto a
 *   display when that position is on none. The first time, it opens at
 *   1440 by 900, centred.
 * - Closing it hides it and the app keeps running, or quits the app, as the
 *   platform's `closingWindow` says. Quitting closes it either way.
 * - On macOS the page fills the whole window, title bar included, and
 *   macOS draws the traffic lights over it. Elsewhere the window has the
 *   system's own frame, title bar and menu bar.
 * - Its state is saved when closing hides it and when the app quits, never
 *   while it moves or resizes.
 */
import path from "node:path";
import { app, BrowserWindow, dialog, Menu, nativeTheme, screen, webContents } from "electron";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  MAIN_TO_RENDERER_IPC_CHANNELS,
  type IpcPayload,
  type MainToRendererIpcChannelName,
} from "../ipc/contract";
import type { DesktopPlatform } from "../ipc/platform/desktop-platform";
import { AppSettings, type Bounds, type WindowState } from "./app-settings";
import { MainWindow } from "./main-window";
import { PLATFORM_BEHAVIOUR } from "./platform-behaviour";
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
 * Creates the window for `platform`, hidden, and wires its events. The window
 * shows itself once its page reports its first screen.
 *
 * The window and the listeners on the app are released when main's runtime
 * shuts down: the listeners are removed, and the window is destroyed if it
 * is still open.
 */
const make = Effect.fnUntraced(function* (platform: DesktopPlatform) {
  const behaviour = PLATFORM_BEHAVIOUR[platform];
  // Electron creates no window before it is ready, and an `activate` or
  // `second-instance` event can build this layer before then.
  yield* Effect.promise(() => app.whenReady());
  const settings = yield* AppSettings;
  const saved = yield* settings.readWindowState;
  /** Returns the `--bg` of the theme in use now. */
  const readBackground = Effect.map(settings.readAppearance, (appearance) =>
    chooseWindowBackground(appearance, nativeTheme.shouldUseDarkColors),
  );
  const initialBackground = yield* readBackground;

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

  // With `hiddenInset`, the page fills the whole window, title bar included.
  const window = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new BrowserWindow({
          ...chooseWindowBounds(saved),
          minWidth: MINIMUM_WINDOW_SIZE.width,
          minHeight: MINIMUM_WINDOW_SIZE.height,
          show: false,
          backgroundColor: initialBackground,
          ...(behaviour.insetTitleBar
            ? { titleBarStyle: "hiddenInset", trafficLightPosition: TRAFFIC_LIGHT_POSITION }
            : {}),
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
    closingWindow: behaviour.closingWindow,
    quitApp: () => app.quit(),
    saveWindowState: startSavingWindowState,
    logError: (message) => {
      runInBackground(Effect.logError(message));
    },
  });
  // A save that keeps the theme, such as a Glass change, leaves the colour as
  // it is, so Electron is not asked to repaint the window for nothing.
  // Electron returns the colour in upper case.
  const paintBackground = Effect.map(readBackground, (color) => {
    if (window.isDestroyed() || window.getBackgroundColor().toLowerCase() === color) return;
    window.setBackgroundColor(color);
  });
  const repaintOnSystemAppearanceChange = () => Effect.runSync(paintBackground);

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
    Effect.sync(() => nativeTheme.on("updated", repaintOnSystemAppearanceChange)),
    () => Effect.sync(() => nativeTheme.off("updated", repaintOnSystemAppearanceChange)),
  );
  yield* Effect.acquireRelease(
    Effect.sync(() => app.on("before-quit", visibility.prepareToQuit)),
    () => Effect.sync(() => app.off("before-quit", visibility.prepareToQuit)),
  );

  const show = Effect.sync(visibility.showWindow);

  /** Sends `payload` to the page on the main-to-renderer channel `name`, encoded against the IPC contract. */
  const send = <Name extends MainToRendererIpcChannelName>(
    name: Name,
    payload: IpcPayload<Name>,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      // A payload that does not encode is a bug in main, not something the
      // caller can handle, so it is a defect.
      const encoded = yield* Effect.orDie(
        Schema.encodeEffect(MAIN_TO_RENDERER_IPC_CHANNELS[name].payload)(payload),
      );
      window.webContents.send(name, encoded);
    });

  return MainWindow.of({
    load: Effect.tryPromise(() => window.loadURL(RENDERER_URL)).pipe(
      Effect.catch((error) =>
        Effect.logError(`The window could not load ${RENDERER_URL}: ${error.message}`),
      ),
    ),
    reload: Effect.sync(() => window.webContents.reload()),
    paintBackground,
    show,
    showFirstTime: Effect.sync(visibility.showWindowFirstTime),
    isFocused: Effect.sync(() => window.isFocused()),
    showAndSend: (name, payload) =>
      Effect.gen(function* () {
        yield* show;
        yield* send(name, payload);
      }),
    stepHistoryInFocusedContents: (step) =>
      Effect.gen(function* () {
        const focused = webContents.getFocusedWebContents();
        if (focused === window.webContents) yield* send("menu.command", step);
        else if (focused !== null) focused[step]();
        // No web contents of the app has the focus, so a native control has
        // it, such as the search field of the folder sheet. macOS steps it, as
        // the menu's Undo and Redo roles did. Linux has no first responder,
        // and the call does not exist there.
        else if (behaviour.stepsNativeControls) {
          Menu.sendActionToFirstResponder(step === "undo" ? "undo:" : "redo:");
        }
      }),
    showWarning: (message) =>
      Effect.sync(() => {
        void dialog.showMessageBox(window, { type: "warning", message, buttons: ["OK"] });
      }),
    pickFolder: Effect.promise(() =>
      dialog.showOpenDialog(window, { properties: ["openDirectory"] }),
    ).pipe(Effect.map(({ canceled, filePaths }) => (canceled ? null : (filePaths[0] ?? null)))),
  });
});

/** Builds the window service for `platform`; see `make`. */
export const makeMainWindowLayer = (
  platform: DesktopPlatform,
): Layer.Layer<MainWindow, never, AppSettings> => Layer.effect(MainWindow)(make(platform));
