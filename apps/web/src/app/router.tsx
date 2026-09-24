/**
 * The router, built from the generated route tree.
 *
 * History is a parameter rather than a default, so the app and a test build the
 * same router: the app passes the browser history, a test passes an in-memory
 * one.
 */
import { createRouter, type RouterHistory } from "@tanstack/react-router";
import { routeTree } from "../routeTree.gen";
import type { RouterContext } from "./context";
import { NotFound, RenderFailure } from "../screens/fallbacks";

export const createAppRouter = (context: RouterContext, history: RouterHistory) =>
  createRouter({
    routeTree,
    context,
    history,
    defaultPreload: "intent",
    // `_shell/$` sits at the top of the tree, so it catches every unknown
    // path the router can parse. These defaults handle the paths it cannot: a
    // path whose percent escapes do not decode never reaches a route, and so
    // never reaches the shell.
    defaultErrorComponent: RenderFailure,
    defaultNotFoundComponent: NotFound,
  });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }

  /** Static data a screen declares for the shell. The shell reads all three fields. */
  interface StaticDataRouteOption {
    readonly title?: string;
    /** The last-checked marker the screen is based on, if it has one. */
    readonly sinceMarker?: "lastChecked.intake";
    /** Set by a screen that renders its own top bar, so the shell does not render one. */
    readonly ownsTopBar?: true;
  }
}
