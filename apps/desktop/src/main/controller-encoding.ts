/**
 * The `Accept-Encoding` header main sets on every request to the saved
 * controller, so that the controller answers with brotli and not gzip.
 *
 * Chromium offers brotli only to an HTTPS or localhost address, and a
 * controller is often reached over plain http on the local network or a
 * tailnet. It decodes a brotli answer over plain http all the same when the
 * request asked for one. Spec 17 (§Reaching the controller) gives the
 * measurement.
 */
import type { Session } from "electron";

/** The codings main asks the controller for: brotli, as well as Chromium's own defaults. */
const CONTROLLER_ACCEPT_ENCODING = "gzip, deflate, br";

/**
 * Checks whether a request to `requestUrl` goes to the controller saved at
 * `controllerUrl`: whether the two URLs have the same origin. Returns false
 * when no controller is saved (`controllerUrl` is `null`).
 *
 * Both URLs must be http or https URLs. The settings only ever hold such a
 * URL, and the request filter in `askControllerForBrotli` lets only such a
 * request through.
 */
export const isControllerRequest = (requestUrl: string, controllerUrl: string | null): boolean =>
  controllerUrl !== null && new URL(requestUrl).origin === new URL(controllerUrl).origin;

/**
 * Makes every http and https request `session` sends to the saved controller
 * ask for brotli, as well as gzip and deflate. A request to any other origin
 * keeps the headers Chromium gave it. The header covers the renderer's
 * requests and main's own `net.fetch` alike, because both go through the
 * session.
 *
 * `readControllerUrl` returns the controller URL saved at the time of the
 * request, so a newly saved controller is asked for brotli from its first
 * request on. The request waits for it; if the returned promise rejects, the
 * request never goes out. Main's settings are in memory, so the promise
 * resolves at once.
 *
 * The filter leaves out the `app` scheme, so the renderer's own files never
 * wait for the controller URL, and the WebSocket's `ws:` and `wss:` URLs,
 * whose upgrade response has no body to compress.
 *
 * Call it from the app's `session-created` event, like `secureSession`.
 */
export const askControllerForBrotli = (
  session: Session,
  readControllerUrl: () => Promise<string | null>,
): void => {
  session.webRequest.onBeforeSendHeaders(
    { urls: ["http://*/*", "https://*/*"] },
    (details, callback) => {
      void readControllerUrl().then((controllerUrl) =>
        callback({
          // Chromium has already set the header, spelled `Accept-Encoding`
          // (observed with Electron 44), so this replaces its value.
          requestHeaders: isControllerRequest(details.url, controllerUrl)
            ? { ...details.requestHeaders, "Accept-Encoding": CONTROLLER_ACCEPT_ENCODING }
            : details.requestHeaders,
        }),
      );
    },
  );
};
