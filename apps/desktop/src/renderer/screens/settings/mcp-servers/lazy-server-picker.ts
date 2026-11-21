import { lazy } from "react";

/**
 * The picker of MCP servers (`ServerPickerDialog`), loaded the first time it
 * renders. Settings > MCP servers opens it only when the user presses Change,
 * so its code stays out of the section's chunk (spec 17 §What MCP servers
 * cost). Render it inside a `Suspense`.
 *
 * This file must never import `./server-picker` as a value, or the code would
 * load with the section again.
 */
export const LazyServerPickerDialog = lazy(() =>
  import("./server-picker").then((module) => ({ default: module.ServerPickerDialog })),
);
