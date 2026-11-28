import { lazy } from "react";

/**
 * The Connection's setup and Reconnect dialog (`ConnectionSetupDialog`),
 * loaded the first time it renders. A server's page and a thread's line
 * open it only when the user presses Reconnect, so its code stays out of
 * their chunks. Render it inside a `Suspense`.
 *
 * This file must never import `./connection-setup-dialog` as a value, or the
 * code would load with the screen again.
 */
export const LazyConnectionSetupDialog = lazy(() =>
  import("./connection-setup-dialog").then((module) => ({
    default: module.ConnectionSetupDialog,
  })),
);
