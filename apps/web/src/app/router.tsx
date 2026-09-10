/**
 * The router, built from the generated route tree.
 *
 * History is a parameter rather than a default so the app and a test build the
 * same router: the app hands it the browser's, a test hands it one in memory.
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
    // `_shell/$` is pathless and sits at the top of the tree, so it answers
    // every unknown address the router can parse. The default is for the ones
    // it cannot: a path whose percent escapes do not decode never reaches a
    // route, and so never reaches the shell.
    defaultErrorComponent: RenderFailure,
    defaultNotFoundComponent: NotFound,
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

/**
 * What a screen hands the shell about itself through its loader, for a title
 * `staticData` cannot carry because it names one record rather than the
 * screen: a thread's own title and its `thread · <id>` crumb (spec 14 §App
 * shell, "On a thread: `project / title`, a `thread · <short id>` crumb").
 * The top bar reads this in place of the static title wherever a route's
 * loader returns one, so it stays generic to every such route rather than
 * knowing about threads specifically.
 */
export interface RouteCrumb {
  /** Declared, not inferred: a loader returning a title and a crumb by coincidence is not one. */
  readonly _tag: "crumb";
  readonly title: string;
  readonly crumb: string;
}

export const isRouteCrumb = (data: unknown): data is RouteCrumb =>
  typeof data === "object" &&
  data !== null &&
  (data as Partial<RouteCrumb>)._tag === "crumb" &&
  typeof (data as Partial<RouteCrumb>).title === "string" &&
  typeof (data as Partial<RouteCrumb>).crumb === "string";
