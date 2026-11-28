import { lazy } from "react";

/**
 * The add-account flow (`AddProviderAccount`), loaded the first time it
 * renders, so the sheet's code is not part of the scripts of the screen that
 * offers it (spec 17 section Performance). Render it inside a `Suspense`.
 *
 * This file must never import `./add-provider-account` as a value, or the
 * code would load with the screen again.
 */
export const LazyAddProviderAccount = lazy(() =>
  import("./add-provider-account").then((module) => ({ default: module.AddProviderAccount })),
);
