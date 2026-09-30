/**
 * The security hooks main installs on every web contents and every session
 * the app creates. Spec 17 (§Security baseline) owns the rules. Every rule
 * refuses outright except one: which links open in the browser. `isHttpUrl`
 * makes that decision and is tested without Electron.
 */
import { shell, type Session, type WebContents } from "electron";
import * as Effect from "effect/Effect";
import { isHttpUrl } from "./http-url";

/**
 * Opens an `http:` or `https:` URL in the default browser, and ignores any
 * other URL. A URL the browser cannot open is logged as a warning; the
 * returned effect never fails.
 *
 * `shell.openExternal` is read when a link is opened, not when this module
 * loads, so an end-to-end test can replace it and see the URL without a
 * browser opening.
 */
export const openInBrowser = (url: string): Effect.Effect<void> =>
  isHttpUrl(url)
    ? Effect.tryPromise(() => shell.openExternal(url)).pipe(
        Effect.catch((error) =>
          Effect.logWarning(`Could not open ${url} in the browser: ${error.message}`),
        ),
      )
    : Effect.void;

/**
 * Installs the security hooks on `contents`, a web contents just created:
 *
 * - it never navigates and never follows a redirect: the page stays on
 *   `app://hercule`. A link to an `http:` or `https:` URL opens in the
 *   browser instead;
 * - it opens no window: `window.open` and links to a new window are denied,
 *   and an `http:` or `https:` URL opens in the browser instead.
 *
 * Electron's hooks are synchronous, so the link is opened by the effect
 * `runEffect` is given, which runs it on main's runtime and so logs like the
 * rest of main.
 *
 * Pinch-to-zoom needs no hook: Electron turns visual zoom off by default.
 *
 * Call it from the app's `web-contents-created` event, which fires before any
 * page loads in the new web contents.
 */
export const secureWebContents = (
  contents: WebContents,
  runEffect: (effect: Effect.Effect<void>) => void,
): void => {
  contents.on("will-navigate", (event) => {
    event.preventDefault();
    runEffect(openInBrowser(event.url));
  });
  contents.on("will-redirect", (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    runEffect(openInBrowser(url));
    return { action: "deny" };
  });
};

/**
 * Makes `session` grant no permission, whatever a page asks for. That
 * includes the local network ones: Electron 44 turns Chromium's Local
 * Network Access checks off, so the renderer reaches a controller on
 * loopback or on the local network without them.
 *
 * Call it from the app's `session-created` event, registered before the app
 * is ready. Electron creates the default session once the app is ready, and
 * emits the event for it too, so every session the app uses is covered.
 */
export const secureSession = (session: Session): void => {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
};
