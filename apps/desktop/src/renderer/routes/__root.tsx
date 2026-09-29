import { useEffect, type JSX } from "react";
import { createRootRouteWithContext, Outlet, useRouter } from "@tanstack/react-router";
import type { RouterContext, SavedController } from "../app/context";
import { revokeToken } from "../app/controller-client";
import { LOGIN_PATH } from "../app/entry-guard";

/**
 * The root route. It renders the matched child route: the connect screen, or
 * the `_connected` layout route, under which sit every screen that needs the
 * controller.
 *
 * It also carries out Sign Out from the app menu whenever a controller is
 * saved. Sign Out lives here rather than in the shell, so it also works from
 * the connect screen while the controller is down.
 */
export const Route = createRootRouteWithContext<RouterContext>()({
  component: Root,
});

function Root(): JSX.Element {
  const { controller } = Route.useRouteContext();
  return (
    <>
      {controller === null ? null : <SignOutOnMenuCommand controller={controller} />}
      <Outlet />
    </>
  );
}

/**
 * Signs the user out when main sends the Sign Out menu command. Renders
 * nothing.
 *
 * Sign Out never waits on the controller (spec 17, Auth and the token). A
 * controller that hangs must not keep a user signed in who asked to be signed
 * out, and a quit in that moment must not leave the token on disk. So Sign
 * Out, in this order:
 *
 * - forgets the token, in memory and in main's store;
 * - asks the controller to revoke that token, and ignores the answer;
 * - shows the sign-in screen;
 * - empties the query cache and the router's cache of past screens, because
 *   everything in them was read as the user who just signed out.
 *
 * The caches are emptied only once the sign-in screen shows. The entry guard
 * reads the controller's setup state from the query cache, and with the cache
 * emptied first it would ask the controller again before it let the user
 * through.
 *
 * The revoke is a plain call rather than a `useMutation`: no screen shows its
 * progress or its outcome.
 */
function SignOutOnMenuCommand({ controller }: { readonly controller: SavedController }): null {
  const { bridge, queryClient } = Route.useRouteContext();
  const router = useRouter();

  useEffect(
    () =>
      bridge.menu.onCommand((command) => {
        if (command !== "signOut") return;
        const token = controller.client.getToken();
        controller.client.setToken(null);
        if (token !== null) revokeToken(controller.url, token);
        void router.navigate({ to: LOGIN_PATH }).then(() => {
          queryClient.clear();
          router.clearCache();
        });
      }),
    [bridge, controller, queryClient, router],
  );

  return null;
}
