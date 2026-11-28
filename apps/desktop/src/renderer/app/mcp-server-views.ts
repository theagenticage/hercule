/**
 * The MCP servers joined with their Connections, for the screens of an open
 * thread (see `ThreadServersProvider`).
 */
import { useEffect, useMemo, useState } from "react";
import type { McpServerView } from "@hercule/client-core/mcp-servers";
import { loadMcpServerViewsBuilder } from "./load-mcp-server-views-builder";
import type { Connection, McpServer, PluginDetail } from "@hercule/contract";

type BuildViews = Awaited<ReturnType<typeof loadMcpServerViewsBuilder>>;

/**
 * Returns the views of every MCP server: the servers joined with their
 * Connections and the plugins that offer them. Returns `undefined` while
 * `wanted` is false, while the code that joins them loads, and until the
 * three records are read.
 *
 * The code that joins them is not part of the first screen. It loads the
 * first time `wanted` is true, and the views are built once for the records
 * given, so a thread's line, menu and picker share them.
 */
export function useMcpServerViews(
  wanted: boolean,
  servers: readonly McpServer[] | undefined,
  connections: readonly Connection[] | undefined,
  plugins: readonly PluginDetail[] | undefined,
): readonly McpServerView[] | undefined {
  const [build, setBuild] = useState<BuildViews | null>(null);
  useEffect(() => {
    if (!wanted || build !== null) return;
    let cancelled = false;
    void loadMcpServerViewsBuilder().then((loaded) => {
      if (!cancelled) setBuild(() => loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [wanted, build]);
  return useMemo(
    () =>
      wanted &&
      build !== null &&
      servers !== undefined &&
      connections !== undefined &&
      plugins !== undefined
        ? build(servers, connections, plugins)
        : undefined,
    [wanted, build, servers, connections, plugins],
  );
}
