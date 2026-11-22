import { lazy } from "react";

/**
 * What the composer's `+` menu loads when it is needed, so the first screen
 * holds none of the code that reads, joins and writes a thread's MCP servers
 * (spec 17 §What MCP servers cost). The `+` and its two rows are part of the
 * first screen. Render each of these inside a `Suspense`.
 *
 * - `LazyThreadServersJoin`: the reads and the join of the servers with their
 *   Connections, loaded when a line about servers or the open menu or picker
 *   needs them (see `ThreadServersProvider`).
 * - `LazyThreadServersMenu`: the submenu, loaded when the "MCP servers" row opens.
 * - `LazyThreadServerPicker`: the picker, loaded when "N more servers…" is pressed.
 * - `LazyReconnectDialog`: the Reconnect dialog, loaded when a row's button opens it.
 *
 * The submenu and the picker bring the edits of the thread's list with them
 * (see `WithThreadServerEdits`). This file must never import these modules as
 * a value, or their code would load with the composer again.
 */
export const LazyThreadServersJoin = lazy(() =>
  import("./thread-servers-join").then((module) => ({ default: module.ThreadServersJoin })),
);

export const LazyThreadServersMenu = lazy(() => import("./thread-servers-menu"));

export const LazyThreadServerPicker = lazy(() => import("./thread-server-picker"));

export const LazyReconnectDialog = lazy(() =>
  import("./reconnect-dialog").then((module) => ({ default: module.ReconnectDialog })),
);
