/**
 * The app's one window, as the rest of main uses it: the MainWindow service.
 * `window.ts` builds it with Electron.
 *
 * This module imports no Electron, so a service that uses the window can be
 * unit tested with a fake one.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { IpcPayload, MainToRendererIpcChannelName } from "../ipc/contract";

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
     * Paints the window's background with the `--bg` of the theme in use,
     * after the Appearance has changed. The window repaints itself when
     * macOS's appearance changes.
     */
    readonly paintBackground: Effect.Effect<void>;

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
     * Shows and focuses the window, as `show` does, then sends `payload` to
     * the page on the main-to-renderer channel `name`, encoded against the
     * IPC contract. Every message main sends asks the page to act on
     * something the user chose outside it, such as a menu item or a
     * notification, so the user is shown the page that acts.
     */
    readonly showAndSend: <Name extends MainToRendererIpcChannelName>(
      name: Name,
      payload: IpcPayload<Name>,
    ) => Effect.Effect<void>;

    /**
     * Shows `message` in a warning sheet on the window, with an OK button,
     * and returns without waiting for the user to close it.
     */
    readonly showWarning: (message: string) => Effect.Effect<void>;

    /**
     * Shows the system's dialog for picking a folder, in a sheet on the
     * window, and returns the folder's absolute path once the user picks
     * one, or null when the user cancels.
     */
    readonly pickFolder: Effect.Effect<string | null>;
  }
>()("hercule/desktop/MainWindow") {}
