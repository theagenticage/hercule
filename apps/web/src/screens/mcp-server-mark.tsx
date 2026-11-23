import type { JSX } from "react";
import type { PluginDetail } from "@hercule/contract";
import type { McpServerView } from "@hercule/client-core/mcp-servers";
import { ProviderMark } from "./provider-mark";
import { ToolsMark } from "./tools-mark";

/**
 * Draws the mark of an MCP server: its plugin's mark, or the tools mark for a
 * server added by URL, which has no plugin.
 */
export function McpServerMark({
  view,
  plugins,
  className,
}: {
  readonly view: McpServerView;
  readonly plugins: readonly PluginDetail[];
  readonly className?: string | undefined;
}): JSX.Element {
  return view.pluginId === null ? (
    <ToolsMark className={className} />
  ) : (
    <ProviderMark pluginId={view.pluginId} plugins={plugins} className={className} />
  );
}
