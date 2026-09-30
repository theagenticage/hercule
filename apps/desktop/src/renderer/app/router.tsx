/**
 * The router, built from the generated route tree.
 *
 * It keeps its history in memory. A desktop window has no address bar, so no
 * URL is shown or kept (spec 17 §Process model), and the app and a test build
 * the same router.
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "../routeTree.gen";
import { RenderFailure } from "../screens/render-failure";
import type { RouterContext } from "./context";
import { createLaunchHistory } from "./last-thread";

/**
 * Returns a new router. It starts at the last open thread of the saved
 * controller when one is stored, and at `/` otherwise (see `last-thread.ts`).
 * It renders the query cache's provider around every route, so the app and a
 * test render the router alone. A route that fails shows `RenderFailure`.
 *
 * The router also empties the query cache and its own cache of past screens
 * when the user is signed out. It does so when a navigation ends with no
 * token, and the app held one before: when the navigation before it ended,
 * or, for the first navigation, when the app started. Everything in the
 * caches was read as the user who was signed in. Most of the sidebar's reads
 * are kept until something invalidates them, so a user who signs in again
 * would see them as they were, possibly for hours. The user can be signed
 * out in several ways, and this one rule covers all of them:
 *
 * - Sign Out from the app menu;
 * - the controller rejects the token on the live connection;
 * - the controller rejects the token in the shell's reads, at launch or
 *   later.
 *
 * The caches are emptied only once the navigation has ended, on the sign-in
 * screen or the connect screen. Emptied earlier, a screen still on display
 * would read again at once, with no token. And the entry guard, which reads
 * the controller's setup state from the query cache, would have to ask the
 * controller for it again before it let the navigation through.
 */
export const createAppRouter = (context: RouterContext) => {
  const router = createRouter({
    routeTree,
    context,
    history: createLaunchHistory(context.controller?.url ?? null),
    defaultErrorComponent: RenderFailure,
    Wrap: ({ children }) => (
      <QueryClientProvider client={context.queryClient}>{children}</QueryClientProvider>
    ),
  });

  const holdsToken = (): boolean =>
    context.controller !== null && context.controller.client.getToken() !== null;
  let signedIn = holdsToken();
  router.subscribe("onResolved", () => {
    const hasToken = holdsToken();
    if (signedIn && !hasToken) {
      context.queryClient.clear();
      router.clearCache();
    }
    signedIn = hasToken;
  });

  return router;
};

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
