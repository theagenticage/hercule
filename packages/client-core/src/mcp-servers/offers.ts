/**
 * The MCP servers the plugins offer. A plugin registers each one as a
 * contribution of the extension point `mcp-server`, so the list exists before
 * the user has switched any server on and before any record does.
 */
import type { PluginDetail } from "@hercule/contract";
import { readJsonObject } from "../json-shape";

/** One MCP server a plugin offers, decoded from its contribution. */
export interface McpServerOffer {
  /** The qualified id of the contribution, such as `sentry/sentry`. A server's `source.contributionId` names it. */
  readonly contributionId: string;
  /** The plugin that registered the contribution, whose mark the server wears. */
  readonly pluginId: string;
  readonly displayName: string;
  readonly description: string;
  /** The qualified id of the Connection type the server is reached with. */
  readonly connectionType: string;
  /** The scheme, host and optional port of the vendor's server. */
  readonly origin: string;
  /**
   * The name a server of this contribution gets when the user gives none:
   * the word after the slash of the contribution id (`sentry`).
   */
  readonly defaultName: string;
}

/**
 * Returns the MCP servers the plugins offer, in the order of the plugin list.
 * The definition of a contribution arrives as untyped JSON, so a contribution
 * whose definition lacks one of the four text fields is left out: the screens
 * cannot name or reach a server they cannot read.
 */
export const readMcpServerOffers = (plugins: readonly PluginDetail[]): McpServerOffer[] =>
  plugins.flatMap((plugin) =>
    plugin.contributions.flatMap((contribution) => {
      if (contribution.extensionPoint !== "mcp-server") return [];
      const definition = readJsonObject(contribution.definition);
      const displayName = definition?.["displayName"];
      const description = definition?.["description"];
      const connectionType = definition?.["connectionType"];
      const origin = definition?.["origin"];
      if (
        typeof displayName !== "string" ||
        typeof description !== "string" ||
        typeof connectionType !== "string" ||
        typeof origin !== "string"
      ) {
        return [];
      }
      return [
        {
          contributionId: contribution.id,
          pluginId: plugin.id,
          displayName,
          description,
          connectionType,
          origin,
          defaultName: contribution.id.slice(contribution.id.indexOf("/") + 1),
        },
      ];
    }),
  );
