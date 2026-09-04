/**
 * The router, built from the generated route tree.
 *
 * History is a parameter rather than a default so the app and a test build the
 * same router: the app hands it the browser's, a test hands it one in memory.
 */
import { createRouter, type RouterHistory } from "@tanstack/react-router";
import { routeTree } from "../routeTree.gen";
import type { RouterContext } from "./context";
import { RenderFailure } from "./fallbacks";

export const createAppRouter = (context: RouterContext, history: RouterHistory) =>
  createRouter({
    routeTree,
    context,
    history,
    defaultPreload: "intent",
    // An unknown path needs no default: `_shell/$` is pathless and so sits at
    // the top of the tree, which leaves no address for one to answer.
    defaultErrorComponent: RenderFailure,
  });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }

  /** What a screen tells the shell about itself. The top bar reads both. */
  interface StaticDataRouteOption {
    readonly title?: string;
    /** The last-checked marker the screen is framed on, where it is framed on one. */
    readonly sinceMarker?: "lastChecked.intake";
  }
}
