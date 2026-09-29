/**
 * The router, built from the generated route tree.
 *
 * It keeps its history in memory. A desktop window has no address bar, so no
 * URL is shown or kept (spec 17 §Process model), and the app and a test build
 * the same router.
 */
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { routeTree } from "../routeTree.gen";

/** Returns a new router that starts at `/`. */
export const createAppRouter = () => createRouter({ routeTree, history: createMemoryHistory() });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }

  /** What a route states about its screen, read without loading the screen. */
  interface StaticDataRouteOption {
    /** The screen's name. */
    readonly title?: string;
  }
}
