import { lazy } from "react";

/**
 * The sign-in dialog of a server added by URL (`TokenDialog`), loaded the
 * first time it renders. A server's page opens it only when the user presses
 * "Replace token…" or "Sign in again…", so its code stays out of the page's
 * chunk. Render it inside a `Suspense`.
 *
 * This file must never import `./token-dialog` as a value, or the code would
 * load with the page again.
 */
export const LazyTokenDialog = lazy(() =>
  import("./token-dialog").then((module) => ({ default: module.TokenDialog })),
);
