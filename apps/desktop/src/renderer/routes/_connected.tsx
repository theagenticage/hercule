import type { JSX } from "react";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { buildEntryDeps, CONNECT_PATH, resolveEntry } from "../app/entry-guard";
import { CenteredFooter, CenteredScreen } from "../screens/centered-screen";

/**
 * The layout route of every screen that needs the controller. It renders only
 * the matched child route. Its `beforeLoad` is the entry guard: before any
 * screen under it loads, it checks that a controller is saved, that it can be
 * read and is set up, and that the user is signed in.
 *
 * Past the guard, a screen's context holds the saved controller, never `null`,
 * so no screen under this route checks for it.
 */
export const Route = createFileRoute("/_connected")({
  beforeLoad: async ({ context, location }) => {
    const { controller, queryClient } = context;
    // The router redirects when a `redirect` is thrown. The thrown value is a
    // plain descriptor rather than an Error.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (controller === null) throw redirect({ to: CONNECT_PATH, replace: true });

    const elsewhere = await resolveEntry(
      buildEntryDeps(controller.client, queryClient),
      location.pathname,
    );
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (elsewhere !== null) throw redirect({ ...elsewhere, replace: true });
    return { controller };
  },
  // The router shows this while the guard waits, but only once the wait
  // passes its default of one second. A controller that answers at once never
  // flashes it.
  pendingComponent: Connecting,
  // The app starts on this route, so it is not split into a chunk of its own:
  // a split route costs two more requests (its script and its stylesheet)
  // before the first render.
  codeSplitGroupings: [],
});

/**
 * Renders the screen shown while the entry guard waits for the controller:
 * the lockup, the controller being reached, and a Change button that leads
 * to the connect screen. A controller that is slow to answer never leaves the
 * user without a way out, even during the 5 seconds before the app gives up
 * on it.
 */
function Connecting(): JSX.Element {
  // While the guard waits, this route's context is the router's, where the
  // controller is saved: with none saved, the guard redirects at once and
  // this screen never shows.
  const { controller } = Route.useRouteContext();
  const navigate = useNavigate();
  return (
    <CenteredScreen>
      <CenteredFooter
        text={`Connecting to ${controller.url}…`}
        onChange={() => {
          void navigate({ to: CONNECT_PATH });
        }}
      />
    </CenteredScreen>
  );
}
