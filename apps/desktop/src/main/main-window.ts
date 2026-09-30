/**
 * The app's one window, as the rest of main uses it: the MainWindow service.
 * `window.ts` builds it with Electron.
 *
 * This module imports no Electron, so a service that uses the window can be
 * unit tested with a fake one.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { MainToRendererIpcChannelName } from "../ipc/bridge";
import type { MAIN_TO_RENDERER_IPC_CHANNELS } from "../ipc/contract";

/** The payload of the main-to-renderer channel `Name`, before main encodes it. */
type MainToRendererIpcPayload<Name extends MainToRendererIpcChannelName> =
  (typeof MAIN_TO_RENDERER_IPC_CHANNELS)[Name]["payload"]["Type"];

/** The app's one window. */
export class MainWindow extends Context.Service<
  MainWindow,
  {
    /**
     * Loads the renderer's page into the window. Call it once, after the
     * `app` scheme is served. A page that does not load is logged.
     */
    readonly load: Effect.Effect<void>;

    /**
     * Loads the renderer's page again, so that it starts over with the
     * settings saved since: the Content-Security-Policy of its new document
     * allows the controller URL saved now.
     */
    readonly reload: Effect.Effect<void>;

    /**
     * Shows the window and focuses it. Does nothing before the window has
     * shown for the first time.
     */
    readonly show: Effect.Effect<void>;

    /**
     * Shows the window for the first time, when the page reports that its
     * first screen has reached the window. Does nothing once the window has
     * shown: the page reports again after each reload, and more than one
     * screen can report at launch.
     */
    readonly showFirstTime: Effect.Effect<void>;

    /**
     * Returns whether the window has the keyboard focus. It has not while it
     * is hidden or minimized, and while another app is in front.
     */
    readonly isFocused: Effect.Effect<boolean>;

    /**
     * Sends `payload` to the page on the main-to-renderer channel `name`,
     * encoded against the IPC contract.
     */
    readonly send: <Name extends MainToRendererIpcChannelName>(
      name: Name,
      payload: MainToRendererIpcPayload<Name>,
    ) => Effect.Effect<void>;

    /**
     * Shows `message` in a warning sheet on the window, with an OK button,
     * and returns without waiting for the user to close it.
     */
    readonly showWarning: (message: string) => Effect.Effect<void>;
  }
>()("hercule/desktop/MainWindow") {}

/** Loads the renderer's page into the window; see `MainWindow.load`. */
export const loadMainWindow: Effect.Effect<void, never, MainWindow> = MainWindow.use(
  (window) => window.load,
);

/** Shows and focuses the window; see `MainWindow.show`. */
export const showMainWindow: Effect.Effect<void, never, MainWindow> = MainWindow.use(
  (window) => window.show,
);
