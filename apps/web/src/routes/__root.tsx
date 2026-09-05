import { createRootRouteWithContext, Outlet, redirect } from "@tanstack/react-router";
import type { RouterContext } from "../app/context";
import { entryDeps, resolveEntry } from "../app/entry-guard";

/**
 * Every navigation passes the entry guard before its route loads, so a deep
 * link into a screen the visitor cannot have yet is answered by the screen they
 * can.
 *
 * It is also the one place that owns the live connection, because it is the one
 * place that knows whether there is a credential to hold one with. Starting a
 * connection that is already up costs nothing, so every navigation may ask; a
 * navigation with no credential ends the connection, whether the token was
 * signed out or expired under the reader, so that a socket greeted as one
 * person is never left carrying the next.
 */
export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ context, location }) => {
    const deps = entryDeps(context);
    const elsewhere = await resolveEntry(deps, location.pathname);
    if (deps.hasToken()) context.live.start();
    else await context.live.stop();
    // A thrown redirect is how the router is told to go elsewhere, and what it
    // carries is a plain descriptor rather than an error.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (elsewhere !== null) throw redirect({ to: elsewhere, replace: true });
  },
  component: Outlet,
});
