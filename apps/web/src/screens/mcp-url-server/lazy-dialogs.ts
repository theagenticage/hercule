import { lazy } from "react";

/**
 * The three dialogs that write a server added by URL, each loaded the first
 * time it opens, so a thread, the server list and a server's page carry none
 * of the code that runs a sign-in or an Add. Render each inside a `Suspense`.
 *
 * - `LazyAddByUrlDialog`: Add by URL, opened from the list.
 * - `LazyReplaceDialog`: Replace, opened by the switch of a plugin's server.
 * - `LazyTokenDialog`: the sign-in dialog, opened from a server's page, a
 *   thread's line and the thread's `+` menu.
 *
 * This file must never import the dialogs' modules as values, or their code
 * would load with the screen again.
 */
export const LazyAddByUrlDialog = lazy(() =>
  import("./add-dialog").then((module) => ({ default: module.AddByUrlDialog })),
);

export const LazyReplaceDialog = lazy(() =>
  import("./replace-dialog").then((module) => ({ default: module.ReplaceDialog })),
);

export const LazyTokenDialog = lazy(() =>
  import("./token-dialog").then((module) => ({ default: module.TokenDialog })),
);
