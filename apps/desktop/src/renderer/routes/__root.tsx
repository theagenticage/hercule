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
 * - stops the live connection, without waiting for it to close;
 * - asks the controller to revoke the token, and ignores the answer;
 * - shows the sign-in screen. Once it shows, the router empties the query
 *   cache and its cache of past screens (see `createAppRouter`).
 *
 * The sidebar stays on screen until the navigation ends. With the live
 * connection stopped, later pushes no longer make it read again, but it can
 * still send a read that was already on its way: the second read that
 * `invalidateWithoutCancelling` runs after a read in progress, or a read that
 * `useRelatedReads` starts for a record the thread list names. That read goes
 * out with no token, and the controller refuses it. Nothing is lost: the
 * token is already forgotten, and the caches are emptied once the sign-in
 * screen shows.
 *
 * The revoke is a plain call rather than a `useMutation`: no screen shows its
 * progress or its outcome.
 */
function SignOutOnMenuCommand({ controller }: { readonly controller: SavedController }): null {
  const { bridge } = Route.useRouteContext();
  const router = useRouter();

  useEffect(
    () =>
      bridge.menu.onCommand((command) => {
        if (command !== "signOut") return;
        const token = controller.client.getToken();
        controller.client.setToken(null);
        void controller.live.stop();
        if (token !== null) revokeToken(controller.url, token);
        void router.navigate({ to: LOGIN_PATH });
      }),
    [bridge, controller, router],
  );

  return null;
}
