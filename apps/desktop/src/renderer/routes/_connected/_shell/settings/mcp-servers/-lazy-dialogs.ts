import { lazy } from "react";

/**
 * The two dialogs of the server list, loaded the first time each opens, so
 * the list holds none of the code that writes a server added by URL (spec 17
 * §What MCP servers cost). Render each inside a `Suspense`.
 *
 * - `LazyAddServerDialog`: Add by URL, opened by the "Add by URL" button.
 * - `LazyReplaceDialog`: Replace, opened by the switch of a plugin's server
 *   when servers added by URL sit on its address.
 *
 * This file must never import `./-add-server-dialog` or `./-replace-dialog`
 * as a value, or their code would load with the list again.
 */
export const LazyAddServerDialog = lazy(() =>
  import("./-add-server-dialog").then((module) => ({ default: module.AddServerDialog })),
);

export const LazyReplaceDialog = lazy(() =>
  import("./-replace-dialog").then((module) => ({ default: module.ReplaceDialog })),
);
