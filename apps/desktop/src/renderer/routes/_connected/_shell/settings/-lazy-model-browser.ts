import { lazy } from "react";

/**
 * The model browser (`ModelBrowser`), loaded the first time it renders. It
 * opens only when the user presses "Browse <n> models" or "Browse all <n>",
 * so its code, its logic and its stylesheet stay out of the Providers page's
 * chunk (spec 17 section Performance). Render it inside a `Suspense`.
 *
 * This file must never import `./-model-browser` as a value, or the code
 * would load with the page again.
 */
export const LazyModelBrowser = lazy(() =>
  import("./-model-browser").then((module) => ({ default: module.ModelBrowser })),
);
