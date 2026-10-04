/**
 * The entry guards: they decide where a navigation actually lands, before the
 * screen it asked for loads.
 *
 * `resolveEntry` guards every screen that needs a signed-in user. Its checks
 * run in this order:
 *
 * - a controller that cannot be read goes back to the connect screen;
 * - a controller that has not been set up goes to the first run, which sets
 *   it up;
 * - a user with no token goes to the sign-in screen;
 * - a first run in progress for the controller goes back to the first run;
 * - a signed-in user who asks for the sign-in screen goes home;
 * - everyone else gets the screen they asked for.
 *
 * `resolveFirstRunEntry` guards the first run itself, which also shows while
 * no controller is saved. A controller that was set up elsewhere, such as in
 * the web app, has no first run on this Mac: its user signs in and goes home.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import type { Bridge } from "../../ipc/bridge";
import type { FirstRunProgress } from "../../ipc/contract";
import { firstRunQuery, setupQuery } from "./queries";

export const HOME_PATH = "/";
export const LOGIN_PATH = "/login";
export const CONNECT_PATH = "/connect";
export const FIRST_RUN_PATH = "/first-run";

/** Why the guard sent the user back to the connect screen. */
export type ConnectProblem = "unreachable";

/** Where a guard sends a navigation instead of the screen it asked for. */
export type EntryRedirect =
  | { readonly to: typeof CONNECT_PATH; readonly search: { readonly problem: ConnectProblem } }
  | { readonly to: typeof LOGIN_PATH }
  | { readonly to: typeof HOME_PATH }
  | { readonly to: typeof FIRST_RUN_PATH };

/** The reads the guards depend on, so a test can replace them. */
export interface EntryDeps {
  readonly hasToken: () => boolean;
  readonly readSetup: () => Promise<{ readonly complete: boolean }>;
  /** Reads what main keeps of the first run for the saved controller, or null when nothing. */
  readonly readFirstRun: () => Promise<FirstRunProgress | null>;
}

/** Returns the guards' reads for one controller's client, main, and the app's query cache. */
export const buildEntryDeps = (
  client: HerculeClient,
  bridge: Bridge,
  queryClient: QueryClient,
): EntryDeps => ({
  hasToken: () => client.getToken() !== null,
  readSetup: () => queryClient.ensureQueryData(setupQuery(client)),
  readFirstRun: () => queryClient.ensureQueryData(firstRunQuery(bridge)),
});

/** The redirect for a controller whose setup state cannot be read. */
const UNREACHABLE: EntryRedirect = { to: CONNECT_PATH, search: { problem: "unreachable" } };

/**
 * Reads whether the controller is set up, and returns `null` when the read
 * fails, so a guard can send the user to the connect screen.
 */
const readSetupComplete = async (deps: EntryDeps): Promise<boolean | null> => {
  try {
    return (await deps.readSetup()).complete;
  } catch {
    return null;
  }
};

/**
 * Returns where to send a navigation to `pathname`, a screen that needs the
 * controller, or `null` to let it through. Never fails: a failed read of the
 * controller's setup state sends the user to the connect screen, where they
 * can check the address. Main's first-run record is read only for a
 * signed-in user, because only setup writes it.
 */
export const resolveEntry = async (
  deps: EntryDeps,
  pathname: string,
): Promise<EntryRedirect | null> => {
  const complete = await readSetupComplete(deps);
  if (complete === null) return UNREACHABLE;
  if (!complete) return { to: FIRST_RUN_PATH };
  if (!deps.hasToken()) return pathname === LOGIN_PATH ? null : { to: LOGIN_PATH };
  if ((await deps.readFirstRun()) !== null) return { to: FIRST_RUN_PATH };
  return pathname === LOGIN_PATH ? { to: HOME_PATH } : null;
};

/**
 * Returns where to send a navigation to the first run, or `null` to let it
 * through. `deps` is `null` when no controller is saved, and the first run
 * then opens on its welcome. Never fails, for the reason `resolveEntry` gives.
 *
 * A controller that is set up lets the first run through only while main
 * keeps a first run for it and the user is signed in: the user then resumes
 * where they left off.
 */
export const resolveFirstRunEntry = async (
  deps: EntryDeps | null,
): Promise<EntryRedirect | null> => {
  if (deps === null) return null;
  const complete = await readSetupComplete(deps);
  if (complete === null) return UNREACHABLE;
  if (!complete) return null;
  if (!deps.hasToken()) return { to: LOGIN_PATH };
  return (await deps.readFirstRun()) === null ? { to: HOME_PATH } : null;
};
