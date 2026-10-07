/**
 * The router context: what every route receives.
 *
 * Boot builds everything here once and passes it to the router, rather than
 * leaving it in module-level singletons. That way a test can build its own
 * set, with a fake bridge, and run the same routes.
 */
import type { QueryClient } from "@tanstack/react-query";
import { createLive, type HerculeClient, type Live } from "@hercule/client-core";
import type { Bridge } from "../../ipc/bridge";
import { createControllerClient } from "./controller-client";
import { createPendingSubmissions, type PendingSubmissions } from "./pending-submissions";
import { createQueryClient } from "./query-client";
import { createDesktopTokenStore } from "./token-store";

/**
 * The controller whose URL is saved in the app's settings, a client for it,
 * the live connection to it, and what the user has not sent yet in each of
 * its threads.
 */
export interface SavedController {
  /** The controller's origin, for example `http://127.0.0.1:4937`. */
  readonly url: string;
  readonly client: HerculeClient;
  /**
   * The live connection to the controller. It is created here and does not
   * connect until the shell starts it (see `useLiveConnection`). Most screens
   * never touch it: pushes invalidate query keys. An agent's page on a thread
   * and an assistant's Conversation are the exceptions: each subscribes to its
   * agent's stream and tap through `useSessionLive`.
   */
  readonly live: Live;
  /** What each thread's, Draft Thread's and assistant's composer holds and has not sent yet. */
  readonly pendingSubmissions: PendingSubmissions;
}

export interface RouterContext {
  /** The functions main offers the page. */
  readonly bridge: Bridge;
  /** The saved controller, or `null` until the user has connected to one. */
  readonly controller: SavedController | null;
  readonly queryClient: QueryClient;
}

/**
 * Returns the saved controller at `url`: a client that sends `token` and
 * stores any change to it through main, a live connection that is not
 * started yet, and no pending submissions.
 */
const buildSavedController = (
  url: string,
  token: string | null,
  bridge: Bridge,
): SavedController => {
  const client = createControllerClient(url, createDesktopTokenStore(token, bridge));
  return {
    url,
    client,
    live: createLive({ client, baseUrl: url }),
    pendingSubmissions: createPendingSubmissions(),
  };
};

/**
 * Reads the saved controller URL and the login token from main, and returns
 * the router context built from them. Fails when main refuses either read,
 * which is a bug.
 *
 * Both reads go to main at once. The client needs the token when it is
 * created, so the app cannot start before both have answered.
 */
export const buildRouterContext = async (bridge: Bridge): Promise<RouterContext> => {
  const [controllerUrl, token] = await Promise.all([
    bridge.controllerUrl.read(),
    bridge.token.read(),
  ]);
  return {
    bridge,
    controller: controllerUrl === null ? null : buildSavedController(controllerUrl, token, bridge),
    queryClient: createQueryClient(),
  };
};
