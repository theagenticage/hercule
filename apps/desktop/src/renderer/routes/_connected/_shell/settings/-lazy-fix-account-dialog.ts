import { lazy } from "react";

/**
 * The flow that gives an account a new credential (`FixAccountDialog`),
 * loaded the first time it renders. It opens only when the user presses
 * Replace key or Make a new token, so its code stays out of the Providers
 * page's chunk (spec 17 section Performance). Render it inside a `Suspense`.
 *
 * This file must never import `./-fix-account-dialog` as a value, or the code
 * would load with the page again.
 */
export const LazyFixAccountDialog = lazy(() =>
  import("./-fix-account-dialog").then((module) => ({ default: module.FixAccountDialog })),
);
