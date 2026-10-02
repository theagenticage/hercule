/**
 * Connecting the app to a controller: the user types an address on the
 * connect screen, or main finds Hercule on this Mac, and main checks the
 * controller there before it saves its URL. Spec 17 (§Connecting) owns the
 * rules.
 *
 * The check lives in `./controller-check`, which main imports only when it
 * first checks a controller, so it stays off the launch path.
 *
 * This module imports no Electron: the layer is given the function the check
 * sends its requests with, so the service is unit tested with a stand-in.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ControllerUrlSaveOutcome } from "../ipc/contract";
import { AppSettings } from "./app-settings";
import type { FetchWithoutRedirects } from "./fetch-without-redirects";
import { isHttpUrl } from "./http-url";
import { MainWindow } from "./main-window";
import { StoredToken } from "./stored-token";

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
  if (!isHttpUrl(text)) return null;
  const url = new URL(text);
  // The full URL is its origin plus "/" exactly when it has no user name,
  // password, path, query or fragment; even an empty query, "?", counts.
  return url.href === `${url.origin}/` ? url.origin : null;
};

/**
 * A controller address the user typed: the controller's origin, and the
 * setup token when the address is a setup address.
 */
export interface ControllerAddress {
  readonly origin: string;
  readonly setupToken: string | null;
}

/**
 * Returns the origin of `text`, and its setup token, when `text` is either:
 *
 * - a controller's origin, as parseControllerUrl accepts it. Its setup token
 *   is null;
 * - a setup address, as `hercule setup-url` prints it: such an origin
 *   followed by `/setup?token=<token>`, with nothing else and a token that
 *   is not empty.
 *
 * Returns null for any other text. The setup address is the one exception to
 * the rule that a controller is typed as its origin, because it is what the
 * user copies from the controller's machine to set it up from this one.
 */
export const parseControllerAddress = (text: string): ControllerAddress | null => {
  const origin = parseControllerUrl(text);
  if (origin !== null) return { origin, setupToken: null };
  if (!isHttpUrl(text)) return null;
  const url = new URL(text);
  const setupToken = url.searchParams.get("token");
  // The full URL is the origin, the path and the query exactly when it has no
  // user name, password or fragment, not even an empty one, "#".
  const isSetupAddress =
    url.href === `${url.origin}/setup${url.search}` &&
    [...url.searchParams.keys()].join() === "token" &&
    setupToken !== null &&
    setupToken !== "";
  return isSetupAddress ? { origin: url.origin, setupToken } : null;
};

/** The connection to a controller. */
export class ControllerConnection extends Context.Service<
  ControllerConnection,
  {
    /**
     * Checks the controller at the address the user typed, `input`, and
     * returns the outcome, with the origin parsed from `input` in every
     * outcome but `InvalidUrl`:
     *
     * - `InvalidUrl` when `input` is not a controller address; see
     *   parseControllerAddress. Nothing is requested;
     * - `Saved` when a controller answered, set up or not. The URL is saved
     *   as `saveIfAnswering` saves it. When the controller is not set up and
     *   `input` is a setup address, its token is kept in memory, for
     *   `takePastedSetupToken`;
     * - the check's outcome otherwise; see ControllerCheckOutcome.
     *
     * A controller that is not set up is saved too, because the app sets it
     * up in its first run; no browser opens.
     *
     * Only `Saved` changes the saved URL. Never fails.
     */
    readonly save: (input: string) => Effect.Effect<ControllerUrlSaveOutcome>;

    /**
     * Checks the controller at `origin`, a controller's origin, and saves its
     * URL when it answers, set up or not. A URL other than the saved one
     * signs the user out first, as Sign Out does. The window then reloads,
     * so the page's Content Security Policy names the new controller.
     * Returns whether it saved the URL. Never fails.
     */
    readonly saveIfAnswering: (origin: string) => Effect.Effect<boolean>;

    /**
     * Returns the token of the setup address the user pasted for `origin`,
     * and forgets it, so that it is returned once. Returns null when the
     * user has pasted none for `origin` since main started.
     */
    readonly takePastedSetupToken: (origin: string) => Effect.Effect<string | null>;
  }
>()("hercule/desktop/ControllerConnection") {}

/**
 * Builds the connection service on the settings file, the stored token and
 * the window. The check sends its requests with `fetchWithoutRedirects`.
 */
export const makeControllerConnectionLayer = (
  fetchWithoutRedirects: FetchWithoutRedirects,
): Layer.Layer<ControllerConnection, never, AppSettings | StoredToken | MainWindow> =>
  Layer.effect(ControllerConnection)(
    Effect.gen(function* () {
      const settings = yield* AppSettings;
      const storedToken = yield* StoredToken;
      const window = yield* MainWindow;
      // The setup address the user pasted last. It is kept in memory only,
      // so it outlives the window's reload, and is gone when main quits.
      let pastedSetupAddress: { readonly origin: string; readonly token: string } | null = null;

      /** Checks the controller at `origin`, with the check imported when it is first needed. */
      const checkOrigin = (origin: string) =>
        Effect.promise(() => import("./controller-check")).pipe(
          Effect.flatMap(({ checkController }) => checkController(origin, fetchWithoutRedirects)),
        );

      /**
       * Saves `origin` as the controller URL and reloads the window. A URL
       * other than the saved one signs the user out first.
       */
      const saveAndReload = (origin: string): Effect.Effect<void> =>
        Effect.gen(function* () {
          // The token belongs to the controller saved before. Signing out
          // at once empties the menu, the dock badge and the
          // notifications, which are about that controller's threads,
          // without waiting for the reloaded page to find no token.
          if (origin !== (yield* settings.readControllerUrl)) {
            // Only storing a token can fail with NoControllerSaved.
            yield* storedToken.write(null).pipe(Effect.catchTag("NoControllerSaved", Effect.die));
          }
          // The settings file is in the app's own folder, so a write that
          // fails is a defect.
          yield* settings
            .saveControllerUrl(origin)
            .pipe(Effect.catchTag("PlatformError", Effect.die));
          yield* window.reload;
        });

      return ControllerConnection.of({
        save: (input) =>
          Effect.gen(function* () {
            const address = parseControllerAddress(input);
            if (address === null) return { _tag: "InvalidUrl" } as const;
            const { origin, setupToken } = address;
            const outcome = yield* checkOrigin(origin);
            if (outcome._tag !== "Ready" && outcome._tag !== "SetupIncomplete") {
              return { ...outcome, origin };
            }
            if (outcome._tag === "SetupIncomplete" && setupToken !== null) {
              pastedSetupAddress = { origin, token: setupToken };
            }
            yield* saveAndReload(origin);
            return { _tag: "Saved", origin } as const;
          }),
        saveIfAnswering: (origin) =>
          Effect.gen(function* () {
            const outcome = yield* checkOrigin(origin);
            if (outcome._tag !== "Ready" && outcome._tag !== "SetupIncomplete") return false;
            yield* saveAndReload(origin);
            return true;
          }),
        takePastedSetupToken: (origin) =>
          Effect.sync(() => {
            if (pastedSetupAddress?.origin !== origin) return null;
            const { token } = pastedSetupAddress;
            pastedSetupAddress = null;
            return token;
          }),
      });
    }),
  );
