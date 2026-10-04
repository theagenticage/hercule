import { useEffect, type JSX } from "react";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { buildEntryDeps, CONNECT_PATH, FIRST_RUN_PATH, resolveEntry } from "../app/entry-guard";
import { reportFirstScreen } from "../app/presented-frame";
import { CenteredFooter, CenteredScreen } from "../screens/centered-screen";

/**
 * The layout route of every screen that needs the controller. It renders only
 * the matched child route. Its `beforeLoad` is the entry guard: before any
 * screen under it loads, it checks that a controller is saved, that it can be
 * read and is set up, that the user is signed in, and that no first run is in
 * progress. With no controller saved, the first run's welcome shows instead.
 *
 * Past the guard, a screen's context holds the saved controller, never `null`,
 * so no screen under this route checks for it.
 */
export const Route = createFileRoute("/_connected")({
  beforeLoad: async ({ context, location }) => {
    const { bridge, controller, queryClient } = context;
    // The router redirects when a `redirect` is thrown. The thrown value is a
    // plain descriptor rather than an Error.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (controller === null) throw redirect({ to: FIRST_RUN_PATH, replace: true });

    const elsewhere = await resolveEntry(
      buildEntryDeps(controller.client, bridge, queryClient),
      location.pathname,
    );
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (elsewhere !== null) throw redirect({ ...elsewhere, replace: true });
    return { controller };
  },
  // The router shows this while the guard waits, but only once the wait
  // passes one second, so a controller that answers at once never flashes
  // it. Main's time limit for the first screen (`FIRST_SCREEN_TIMEOUT_MS` in
  // src/main/window-visibility.ts) leaves room for this second: raising it
  // means raising that limit too.
  pendingComponent: Connecting,
  pendingMs: 1000,
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
 *
 * Once it has reached the window, the screen reports itself to main as the
 * first screen, so a slow controller does not keep the window hidden at
 * launch. After launch, main ignores the report.
 */
function Connecting(): JSX.Element {
  // While the guard waits, this route's context is the router's, where the
  // controller is saved: with none saved, the guard redirects at once and
  // this screen never shows.
  const { bridge, controller } = Route.useRouteContext();
  const navigate = useNavigate();
  useEffect(() => {
    void reportFirstScreen(bridge);
  }, [bridge]);
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
