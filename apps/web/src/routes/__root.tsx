import { createRootRouteWithContext, Outlet, redirect } from "@tanstack/react-router";
import type { RouterContext } from "../app/context";
import { buildEntryDeps, resolveEntry } from "../app/entry-guard";

/**
 * The root route. Every navigation passes the entry guard before its route
 * loads, so a deep link to a screen the visitor cannot use yet redirects to the
 * screen they can use.
 *
 * This route also owns the live connection, because it is the one place that
 * knows whether there is a token to open one with. Starting a connection that
 * is already open costs nothing, so every navigation starts it. A navigation
 * with no token stops the connection, whether the user signed out or the token
 * expired. That way a socket authenticated as one person is never reused for
 * the next.
 */
export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ context, location }) => {
    const deps = buildEntryDeps(context);
    const elsewhere = await resolveEntry(deps, location.pathname);
    if (deps.hasToken()) context.live.start();
    else await context.live.stop();
    // The router redirects when a `redirect` is thrown. The thrown value is a
    // plain descriptor rather than an Error.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (elsewhere !== null) throw redirect({ to: elsewhere, replace: true });
  },
  component: Outlet,
});
