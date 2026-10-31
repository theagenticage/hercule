import { lazy } from "react";

/**
 * A project's context menu (`ProjectProfileMenu`), loaded the first time a
 * project's heading is right-clicked, so the menu's code and styles are not
 * part of the scripts of the first screen (spec 17 section Performance).
 * Render it inside a `Suspense`.
 *
 * This file must never import `./project-profile-menu` as a value, or the code
 * would load with the sidebar again.
 */
export const LazyProjectProfileMenu = lazy(() =>
  import("./project-profile-menu").then((module) => ({ default: module.ProjectProfileMenu })),
);
