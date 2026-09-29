/**
 * The router context: what every route receives.
 *
 * Boot builds everything here once and passes it to the router, rather than
 * leaving it in module-level singletons. That way a test can build its own
 * set, with a fake bridge, and run the same routes.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import type { Bridge } from "../../ipc/bridge";
import { createControllerClient } from "./controller-client";
import { createQueryClient } from "./query-client";
import { createDesktopTokenStore } from "./token-store";

/** The controller whose URL is saved in the app's settings, and a client for it. */
export interface SavedController {
  /** The controller's origin, for example `http://127.0.0.1:4937`. */
  readonly url: string;
  readonly client: HerculeClient;
}

export interface RouterContext {
  /** The functions main offers the page. */
  readonly bridge: Bridge;
  /** The saved controller, or `null` until the user has connected to one. */
  readonly controller: SavedController | null;
  readonly queryClient: QueryClient;
}

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
    controller:
      controllerUrl === null
        ? null
        : {
            url: controllerUrl,
            client: createControllerClient(controllerUrl, createDesktopTokenStore(token, bridge)),
          },
    queryClient: createQueryClient(),
  };
};
