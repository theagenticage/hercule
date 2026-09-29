/**
 * The router, built from the generated route tree.
 *
 * It keeps its history in memory. A desktop window has no address bar, so no
 * URL is shown or kept (spec 17 §Process model), and the app and a test build
 * the same router.
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { routeTree } from "../routeTree.gen";
import type { RouterContext } from "./context";

/**
 * Returns a new router that starts at `/`. It renders the query cache's
 * provider around every route, so the app and a test render the router alone.
 */
export const createAppRouter = (context: RouterContext) =>
  createRouter({
    routeTree,
    context,
    history: createMemoryHistory(),
    Wrap: ({ children }) => (
      <QueryClientProvider client={context.queryClient}>{children}</QueryClientProvider>
    ),
  });

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
