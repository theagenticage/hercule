import { createRootRouteWithContext, Outlet, redirect } from "@tanstack/react-router";
import type { RouterContext } from "../app/context";
import { entryDeps, resolveEntry } from "../app/entry-guard";

/**
 * Every navigation passes the entry guard before its route loads, so a deep
 * link into a screen the visitor cannot have yet is answered by the screen they
 * can.
 */
export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ context, location }) => {
    const elsewhere = await resolveEntry(entryDeps(context), location.pathname);
    // A thrown redirect is how the router is told to go elsewhere, and what it
    // carries is a plain descriptor rather than an error.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (elsewhere !== null) throw redirect({ to: elsewhere, replace: true });
  },
  component: Outlet,
});
