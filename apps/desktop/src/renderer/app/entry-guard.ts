/**
 * The entry guard: decides where a navigation to a screen that needs the
 * controller actually lands.
 *
 * The checks run in this order:
 *
 * - a controller that cannot be read goes back to the connect screen;
 * - so does a controller that has not been set up;
 * - a user with no token goes to the sign-in screen;
 * - a signed-in user who asks for the sign-in screen goes home;
 * - everyone else gets the screen they asked for.
 *
 * Setup happens in the browser, and so does onboarding, so the desktop app has
 * a screen for neither.
 *
 * With no saved controller the guard never runs: the `_connected` route sends
 * the user to the connect screen first.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import { setupQuery } from "./queries";

export const HOME_PATH = "/";
export const LOGIN_PATH = "/login";
export const CONNECT_PATH = "/connect";

/** Why the guard sent the user back to the connect screen. */
export type ConnectProblem = "unreachable" | "setupIncomplete";

/** Where the guard sends a navigation instead of the screen it asked for. */
export type EntryRedirect =
  | { readonly to: typeof CONNECT_PATH; readonly search: { readonly problem: ConnectProblem } }
  | { readonly to: typeof LOGIN_PATH }
  | { readonly to: typeof HOME_PATH };

/** The two reads the guard depends on, so a test can replace them. */
export interface EntryDeps {
  readonly hasToken: () => boolean;
  readonly readSetup: () => Promise<{ readonly complete: boolean }>;
}

/** Returns the guard's reads for one controller's client and the app's query cache. */
export const buildEntryDeps = (client: HerculeClient, queryClient: QueryClient): EntryDeps => ({
  hasToken: () => client.getToken() !== null,
  readSetup: () => queryClient.ensureQueryData(setupQuery(client)),
});

/**
 * Returns where to send a navigation to `pathname`, or `null` to let it
 * through. Never fails: a failed read of the controller's setup state sends
 * the user to the connect screen, where they can check the address.
 */
export const resolveEntry = async (
  deps: EntryDeps,
  pathname: string,
): Promise<EntryRedirect | null> => {
  let complete: boolean;
  try {
    ({ complete } = await deps.readSetup());
  } catch {
    return { to: CONNECT_PATH, search: { problem: "unreachable" } };
  }
  if (!complete) return { to: CONNECT_PATH, search: { problem: "setupIncomplete" } };
  if (!deps.hasToken()) return pathname === LOGIN_PATH ? null : { to: LOGIN_PATH };
  return pathname === LOGIN_PATH ? { to: HOME_PATH } : null;
};
