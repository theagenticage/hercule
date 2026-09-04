/**
 * The router, built from the generated route tree.
 *
 * History is a parameter rather than a default so the app and a test build the
 * same router: the app hands it the browser's, a test hands it one in memory.
 */
import { createRouter, type RouterHistory } from "@tanstack/react-router";
import { routeTree } from "../routeTree.gen";
import type { RouterContext } from "./context";

export const createAppRouter = (context: RouterContext, history: RouterHistory) =>
  createRouter({ routeTree, context, history, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }

  /** What a screen tells the shell about itself. The top bar reads the title. */
  interface StaticDataRouteOption {
    readonly title?: string;
  }
}
