/**
 * How the browser's return from a Connection's redirect flow reaches Hercule,
 * and the setup values a type with a client created at setup asks for. The
 * desktop app and the web app both run the redirect flow, and they must agree
 * on which return a type uses, so the decision is made here.
 */
import {
  parseCallbackQuery,
  readAuthorizationState,
  type ConnectionOAuthStart,
} from "@hercule/contract";
import type { HerculeClient } from "./client";
import type { ConnectionType } from "./connection-types";
import { ApiError, ConnectionError, readErrorMessage } from "./errors";
import { buildPastedRedirectUri } from "./mcp-server-sign-in";
import type { BrowserSignInPort } from "./mcp-servers/browser-sign-in";
import {
  BROWSER_WAIT_STOPPED,
  BROWSER_WAIT_TIMED_OUT,
  describePasteRefusal,
} from "./browser-return-words";

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
 * Returns what the user typed into the field called `name`, or an empty string
 * when nothing was typed. A field may carry any name, `constructor` and
 * `__proto__` included, so the name is read only when it is `typed`'s own key:
 * an inherited property is no input.
 */
export const readTypedValue = (typed: Readonly<Record<string, string>>, name: string): string =>
  Object.hasOwn(typed, name) ? (typed[name] ?? "") : "";

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
  // `Object.fromEntries` makes every name an ordinary key, as `__proto__` must be.
  const entries = type.clientSetupFields.map(({ name }) => [name, readTypedValue(typed, name)]);
  return entries.every(([, value]) => value?.trim() !== "")
    ? (Object.fromEntries(entries) as Record<string, string>)
    : undefined;
};

/** What the browser's return came to, as `LocalReturnSignIn.awaitReturn` reports it. */
export type LocalReturn =
  /** The browser came back. `callbackQuery` goes to `connection.finishOAuth` as it is. */
  | { readonly kind: "received"; readonly callbackQuery: string }
  /** The wait ended with no return: `message` says why and what to do. */
  | { readonly kind: "stopped"; readonly message: string };

/**
 * A redirect flow whose return is caught on the user's machine, started and
 * waiting for the browser. The app arms the wait with `awaitReturn` (when
 * `returnBy` is `listener`), then opens the provider's page with `openPage`,
 * or asks the user to paste the address the browser ended on (`returnBy` is
 * `paste`), and then calls `connection.finishOAuth`.
 */
export interface LocalReturnSignIn {
  /** The provider's page, which the app opens in the user's browser. */
  readonly authorizationUrl: string;
  readonly returnBy: "listener" | "paste";
  /**
   * Registers the wait for the browser's return at the listener and returns
   * what came of it. Call it before `openPage`: the listener refuses a return
   * until the wait is registered, so a fast return would be lost. It resolves
   * `stopped` when the start's signal aborted, and at once for a `paste`.
   */
  readonly awaitReturn: () => Promise<LocalReturn>;
  /**
   * Opens `authorizationUrl` in the user's browser through the port. Rejects
   * with the port's own sentence when the browser cannot be opened. Does
   * nothing when the app has no port.
   */
  readonly openPage: () => Promise<void>;
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
 * `signal` is the attempt's lifetime: the listener closes as soon as it
 * aborts, also while the controller has not answered the start yet. Fails
 * with the controller's error when it refuses the start, and with the
 * signal's reason when it aborted first, closing the listener either way.
 */
export const startLocalReturnSignIn = async (
  host: { readonly client: HerculeClient; readonly port: BrowserSignInPort | undefined },
  start: {
    readonly type: string;
    readonly connectionId?: string;
    readonly clientValues?: Readonly<Record<string, string>>;
  },
  signal: AbortSignal,
): Promise<LocalReturnSignIn> => {
  const { client, port } = host;
  signal.throwIfAborted();
  const listening = port === undefined ? undefined : await port.listen();
  const listener = listening?.kind === "listening" ? listening : undefined;
  let closed = false;
  const closeListener = (): void => {
    if (closed) return;
    closed = true;
    if (listener !== undefined) void port?.cancel(listener.listenerId).catch(() => {});
  };
  // The listener belongs to the attempt from here on, so it closes when the
  // attempt ends, whether or not the controller has answered the start.
  signal.addEventListener("abort", closeListener, { once: true });
  if (signal.aborted) closeListener();
  let started: ConnectionOAuthStart;
  try {
    signal.throwIfAborted();
    const redirectUri = listener?.redirectUri ?? buildPastedRedirectUri();
    started = await client.connection.startOAuth({ payload: { ...start, redirectUri } });
    signal.throwIfAborted();
  } catch (error) {
    closeListener();
    throw error;
  }
  const stopped = (message: string): LocalReturn => ({ kind: "stopped", message });
  const awaitReturn = async (): Promise<LocalReturn> => {
    if (port === undefined || listener === undefined || signal.aborted) {
      return stopped(BROWSER_WAIT_STOPPED);
    }
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
    openPage: () => port?.open(started.authorizationUrl) ?? Promise.resolve(),
  };
};

/** The reading of an address the user pasted: what to send, or why not. */
export type PastedReturn =
  | { readonly kind: "callback"; readonly callbackQuery: string }
  | { readonly kind: "refused"; readonly message: string };

/**
 * Reads the address the user pasted for the sign-in that opened at
 * `authorizationUrl`. The address is refused, with a message the user can act
 * on, when it is not a redirect answer, or when its `state` differs from the
 * state of this sign-in: it was copied from another sign-in, which the
 * controller would complete in place of this one.
 */
export const readPastedReturn = (authorizationUrl: string, pasted: string): PastedReturn => {
  const parsed = parseCallbackQuery(pasted);
  if (parsed._tag === "Refused") {
    return { kind: "refused", message: describePasteRefusal(parsed.reason) };
  }
  if (parsed.state !== readAuthorizationState(authorizationUrl)) {
    return {
      kind: "refused",
      message:
        "This address is from another sign-in: paste the address the browser ended on for this one.",
    };
  }
  return { kind: "callback", callbackQuery: pasted.trim() };
};

/**
 * What a failed `connection.finishOAuth` means for the sign-in:
 *
 * - `retry`: the controller did not answer, or failed (a server error), so the
 *   sign-in may still be open there. The same address can be sent again.
 *   `message` says that, and to try again.
 * - `refused`: the controller answered that the sign-in is over. `message` is
 *   its own wording, which says why and what to do.
 */
export type FinishFailure =
  | { readonly kind: "retry"; readonly message: string }
  | { readonly kind: "refused"; readonly message: string };

/**
 * Reads the error of a failed `connection.finishOAuth`. Only an answer of the
 * controller ends the sign-in. No answer at all (the network, a timeout) or a
 * server error leaves it open, because the controller may not have seen the
 * request, or may have failed before it used the one-time code.
 */
export const readFinishFailure = (error: unknown): FinishFailure => {
  if (error instanceof ConnectionError) {
    return {
      kind: "retry",
      message: "The controller could not be reached, so the sign-in is not finished. Try again.",
    };
  }
  if (error instanceof ApiError && error.status >= 500) {
    return {
      kind: "retry",
      message: "The controller failed while finishing the sign-in. Try again.",
    };
  }
  return { kind: "refused", message: readErrorMessage(error) };
};
