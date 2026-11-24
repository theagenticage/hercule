/**
 * How the browser's return from a Connection's redirect flow reaches Hercule,
 * and the setup values a type with a client created at setup asks for. The
 * desktop app and the web app both run the redirect flow, and they must agree
 * on which return a type uses, so the decision is made here.
 */
import type { ConnectionOAuthStart } from "@hercule/contract";
import type { HerculeClient } from "./client";
import type { ConnectionType } from "./connection-types";
import { readErrorMessage } from "./errors";
import { buildPastedRedirectUri } from "./mcp-server-sign-in";
import type { BrowserSignInPort } from "./mcp-servers/browser-sign-in";
import { BROWSER_WAIT_STOPPED, BROWSER_WAIT_TIMED_OUT } from "./browser-return-words";

/**
 * The redirect URI a client that catches the return itself names, without its
 * port. A type's public client registers it so the provider accepts any port,
 * because the desktop app listens on a port the system picks.
 */
const LOOPBACK_CALLBACK_URI = "http://127.0.0.1/callback";

/**
 * How the provider's redirect returns to Hercule:
 *
 * - `controller-callback`: the provider sends the browser to the controller's
 *   own `/oauth/callback`, and the controller finishes the sign-in. The start
 *   gives the browser's `origin`.
 * - `local-listener`: the provider sends the browser to a loopback address
 *   where the desktop app listens, and the app hands what came back to
 *   `connection.finishOAuth`. The start gives that `redirectUri`.
 * - `pasted-address`: the same loopback address, but nothing listens there.
 *   The browser shows a page that does not load, and the user pastes its
 *   address. The start gives the `redirectUri`, like `local-listener`.
 */
export type OAuthReturnPath = "controller-callback" | "local-listener" | "pasted-address";

/** The app that runs the redirect flow. */
export type OAuthReturnApp = "desktop" | "web";

/**
 * Decides how the redirect flow of a type returns when `app` runs it.
 *
 * A type whose public client registered the loopback address
 * `http://127.0.0.1/callback` always returns to the user's machine (Slack),
 * also when the web page is itself at a loopback origin. A sign-in that
 * returns to the controller's callback page arrives without the user's
 * credentials, so the controller could not do what only
 * `connection.finishOAuth` lets it do for that user, such as adding the
 * type's MCP server.
 *
 * - The desktop app catches the return itself, wherever the controller is.
 * - The web app cannot listen, so the user pastes the address the browser
 *   ended on.
 *
 * Every other type keeps the controller's callback, as before, including a
 * type with a public client that registered only addresses of the controller
 * (Linear), whose refusal at an unregistered origin comes from the controller.
 */
export const decideOAuthReturnPath = (
  type: ConnectionType,
  app: OAuthReturnApp,
): OAuthReturnPath => {
  if (!type.registeredRedirectUris.includes(LOOPBACK_CALLBACK_URI)) return "controller-callback";
  return app === "desktop" ? "local-listener" : "pasted-address";
};

/**
 * Returns the values to send as `clientValues`: one for each field the type's
 * client setup declares, from what the user typed. Returns `undefined` when
 * the type creates no client at setup, or when a value is still blank,
 * because the controller refuses a start with an empty one.
 */
export const readClientValues = (
  type: ConnectionType,
  typed: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> | undefined => {
  if (type.clientSetupFields.length === 0) return undefined;
  const values: Record<string, string> = {};
  for (const { name } of type.clientSetupFields) {
    const value = typed[name] ?? "";
    if (value.trim() === "") return undefined;
    values[name] = value;
  }
  return values;
};

/** What the browser's return came to, as `LocalReturnSignIn.awaitReturn` reports it. */
export type LocalReturn =
  /** The browser came back. `callbackQuery` goes to `connection.finishOAuth` as it is. */
  | { readonly kind: "received"; readonly callbackQuery: string }
  /** The wait ended with no return: `message` says why and what to do. */
  | { readonly kind: "stopped"; readonly message: string };

/**
 * A redirect flow whose return is caught on the user's machine, started and
 * waiting for the browser. The app opens `authorizationUrl`, then either waits
 * with `awaitReturn` (`returnBy` is `listener`) or asks the user to paste the
 * address the browser ended on (`returnBy` is `paste`), and then calls
 * `connection.finishOAuth`.
 */
export interface LocalReturnSignIn {
  /** The provider's page, which the app opens in the user's browser. */
  readonly authorizationUrl: string;
  readonly returnBy: "listener" | "paste";
  /**
   * Waits for the browser to come back to the listener. Resolves with what
   * came of the wait, and `stopped` when `close` ended it. Only a sign-in
   * with a `listener` waits: for a `paste` it resolves `stopped` at once.
   */
  readonly awaitReturn: () => Promise<LocalReturn>;
  /** Ends the listener. It may be called more than once, and does nothing after the first. */
  readonly close: () => void;
}

/**
 * Starts a redirect flow that returns to the user's machine: opens a listener
 * through `port` when the app has one, and gives the controller its address
 * as the `redirectUri` of `connection.startOAuth`. When `port` is missing or
 * cannot listen, the redirect URI is an address nothing listens on, and the
 * user pastes it back.
 *
 * `start` is the start's payload without its redirect: the type, the
 * Connection being reconnected, and the values for the type's client setup.
 * Fails with the controller's error when it refuses the start, after closing
 * the listener it opened.
 */
export const startLocalReturnSignIn = async (
  host: { readonly client: HerculeClient; readonly port: BrowserSignInPort | undefined },
  start: {
    readonly type: string;
    readonly connectionId?: string;
    readonly clientValues?: Readonly<Record<string, string>>;
  },
): Promise<LocalReturnSignIn> => {
  const { client, port } = host;
  const listening = port === undefined ? undefined : await port.listen();
  const listener = listening?.kind === "listening" ? listening : undefined;
  const redirectUri = listener?.redirectUri ?? buildPastedRedirectUri();
  let started: ConnectionOAuthStart;
  try {
    started = await client.connection.startOAuth({ payload: { ...start, redirectUri } });
  } catch (error) {
    if (listener !== undefined) void port?.cancel(listener.listenerId).catch(() => {});
    throw error;
  }
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (listener !== undefined) void port?.cancel(listener.listenerId).catch(() => {});
  };
  const stopped = (message: string): LocalReturn => ({ kind: "stopped", message });
  const awaitReturn = async (): Promise<LocalReturn> => {
    if (port === undefined || listener === undefined) return stopped(BROWSER_WAIT_STOPPED);
    try {
      const outcome = await port.wait(listener.listenerId, started.authorizationUrl);
      switch (outcome.kind) {
        case "received":
          return outcome;
        case "timed-out":
          return stopped(BROWSER_WAIT_TIMED_OUT);
        case "cancelled":
          return stopped(BROWSER_WAIT_STOPPED);
      }
    } catch (error) {
      return stopped(readErrorMessage(error));
    }
  };
  return {
    authorizationUrl: started.authorizationUrl,
    returnBy: listener === undefined ? "paste" : "listener",
    awaitReturn,
    close,
  };
};
