/**
 * Connecting the app to a controller: the user types a URL on the connect
 * screen, and main checks the controller there before it saves the URL.
 * Spec 17 (§Connecting) owns the rules.
 *
 * The check lives in `./controller-check`, which main imports only when the
 * user first connects, so it stays off the launch path.
 *
 * This module imports no Electron: the layer is given the function that opens
 * a URL in the browser and the one the check sends its requests with, so the
 * service is unit tested with stand-ins for them.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ControllerUrlSaveOutcome } from "../ipc/contract";
import { AppSettings } from "./app-settings";
import type { FetchWithoutRedirects } from "./fetch-without-redirects";
import { MainWindow } from "./main-window";

/**
 * Returns the origin of `text` when `text` is an http or https URL with
 * nothing after the host and port but an optional `/`: no user name,
 * password, path, query or fragment. Returns null for any other text.
 *
 * The app saves a controller as its origin, so a URL that holds anything more
 * is refused rather than trimmed: the user sees what is saved. Leading and
 * trailing spaces are ignored, and the scheme and host are lowercased, as by
 * any URL parser. A default port is dropped: `http://Example.com:80/`
 * returns `http://example.com`.
 */
export const parseControllerUrl = (text: string): string | null => {
  if (!URL.canParse(text)) return null;
  const url = new URL(text);
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // The full URL is its origin plus "/" exactly when it has no user name,
  // password, path, query or fragment; even an empty query, "?", counts.
  return url.href === `${url.origin}/` ? url.origin : null;
};

/** The connection to a controller. */
export class ControllerConnection extends Context.Service<
  ControllerConnection,
  {
    /**
     * Checks the controller at the URL the user typed, `input`, and returns
     * the outcome, with the origin parsed from `input` in every outcome but
     * `InvalidUrl`:
     *
     * - `InvalidUrl` when `input` is not a controller's origin; see
     *   parseControllerUrl. Nothing is requested;
     * - `Saved` when the controller is ready for the app. The URL is saved,
     *   which removes the stored token when the URL is new, and the window
     *   reloads, so the page's Content Security Policy names the new
     *   controller;
     * - `SetupIncomplete` when the controller is not set up yet. Its setup
     *   page opens in the browser, because setup is done in the web app;
     * - the check's outcome otherwise; see ControllerCheckOutcome.
     *
     * Only `Saved` changes the saved URL. Never fails.
     */
    readonly save: (input: string) => Effect.Effect<ControllerUrlSaveOutcome>;
  }
>()("hercule/desktop/ControllerConnection") {}

/**
 * Builds the connection service on the settings file and the window.
 * `openInBrowser` opens a URL in the default browser and never fails. The
 * check sends its requests with `fetchWithoutRedirects`.
 */
export const makeControllerConnectionLayer = (
  openInBrowser: (url: string) => Effect.Effect<void>,
  fetchWithoutRedirects: FetchWithoutRedirects,
): Layer.Layer<ControllerConnection, never, AppSettings | MainWindow> =>
  Layer.effect(ControllerConnection)(
    Effect.gen(function* () {
      const settings = yield* AppSettings;
      const window = yield* MainWindow;
      return ControllerConnection.of({
        save: (input) =>
          Effect.gen(function* () {
            const origin = parseControllerUrl(input);
            if (origin === null) return { _tag: "InvalidUrl" } as const;
            const { checkController } = yield* Effect.promise(() => import("./controller-check"));
            const outcome = yield* checkController(origin, fetchWithoutRedirects);
            if (outcome._tag === "Ready") {
              // The settings file is in the app's own folder, so a write that
              // fails is a defect.
              yield* settings
                .saveControllerUrl(origin)
                .pipe(Effect.catchTag("PlatformError", Effect.die));
              yield* window.reload;
              return { _tag: "Saved", origin } as const;
            }
            if (outcome._tag === "SetupIncomplete") yield* openInBrowser(`${origin}/setup`);
            return { ...outcome, origin };
          }),
      });
    }),
  );
