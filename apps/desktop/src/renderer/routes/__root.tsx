import { useEffect, type JSX } from "react";
import { createRootRouteWithContext, Outlet, useRouter } from "@tanstack/react-router";
import type { RouterContext, SavedController } from "../app/context";
import { signOut } from "../app/sign-out";

/**
 * The root route. It renders the matched child route: the first run, the
 * connect screen, or the `_connected` layout route, under which sit every
 * screen that needs the controller.
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
 * Signs the user out when main sends the Sign Out menu command, see
 * `signOut`. Renders nothing.
 */
function SignOutOnMenuCommand({ controller }: { readonly controller: SavedController }): null {
  const { bridge } = Route.useRouteContext();
  const router = useRouter();

  useEffect(
    () =>
      bridge.menu.onCommand((command) => {
        if (command === "signOut") signOut(controller, router);
      }),
    [bridge, controller, router],
  );

  return null;
}
