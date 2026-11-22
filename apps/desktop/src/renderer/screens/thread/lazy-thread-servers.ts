import { lazy } from "react";

/**
 * What the composer's `+` menu loads when it is needed, so the first screen
 * holds none of the code that reads, joins and writes a thread's MCP servers
 * (spec 17 §What MCP servers cost). Render each inside a `Suspense`.
 *
 * - `LazyStartedThreadPlus` and `LazyDraftPlus`: the `+` menu itself, loaded
 *   when a composer first draws. A plain `+` stands in until then.
 * - `LazyThreadServersMenu`: the submenu, loaded when the "MCP servers" row opens.
 * - `LazyThreadServerPicker`: the picker, loaded when "N more servers…" is pressed.
 *
 * This file must never import any of these modules as a value, or its code
 * would load with the composer again.
 */
export const LazyStartedThreadPlus = lazy(() =>
  import("./thread-plus").then((module) => ({ default: module.StartedThreadPlus })),
);

export const LazyDraftPlus = lazy(() =>
  import("./thread-plus").then((module) => ({ default: module.DraftPlus })),
);

export const LazyThreadServersMenu = lazy(() => import("./thread-servers-menu"));

export const LazyThreadServerPicker = lazy(() => import("./thread-server-picker"));
