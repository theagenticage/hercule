import { lazy } from "react";

/**
 * A thread's line about MCP servers (`McpWarningLine`), loaded the first time
 * a transcript draws one, so the first screen holds none of the code that
 * decides a button. Render it inside a `Suspense` whose fallback is the
 * plain warning.
 *
 * This file must never import `./mcp-warning-line` as a value, or the code
 * would load with the transcript again.
 */
export const LazyMcpWarningLine = lazy(() => import("./mcp-warning-line"));
