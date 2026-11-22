/**
 * The MCP servers the plugins offer. A plugin registers each one as a
 * contribution of the extension point `mcp-server`, so the list exists before
 * the user has switched any server on and before any record does.
 */
import type { Connection, McpServer, PluginDetail } from "@hercule/contract";
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

/**
 * Returns the address a plugin's server is reached at, for a chip on the
 * server's page: the offer's `origin` without its scheme, such as
 * `mcp.sentry.dev`.
 */
export const describeOfferAddress = (origin: string): string =>
  origin.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");

/** One offer on one Connection, with the server record switched on for it, if any. */
export interface OfferedServer {
  readonly offer: McpServerOffer;
  readonly connection: Connection;
  /** The record whose source names this contribution and this Connection, or `null` while the server was never switched on. */
  readonly server: McpServer | null;
}

/**
 * Returns one entry for each Connection whose type a plugin's MCP server
 * contribution names, paired with that contribution (a plugin that offers two
 * servers on one Connection type gives two entries per Connection), in the
 * order of the offers, then of `connections`. The record is the one whose
 * source names both the contribution and the Connection, and `null` when
 * there is none, so an offer nobody switched on is still listed.
 *
 * Settings and a Connection's "agent tools" note both start from this list, so
 * they agree on which record belongs to which offer.
 */
export const joinOfferedServers = ({
  servers,
  connections,
  plugins,
}: {
  readonly servers: readonly McpServer[];
  readonly connections: readonly Connection[];
  readonly plugins: readonly PluginDetail[];
}): OfferedServer[] =>
  readMcpServerOffers(plugins).flatMap((offer) =>
    connections
      .filter((connection) => connection.type === offer.connectionType)
      .map((connection) => ({
        offer,
        connection,
        server:
          servers.find(
            ({ source }) =>
              source.kind === "plugin" &&
              source.contributionId === offer.contributionId &&
              source.connectionId === connection.id,
          ) ?? null,
      })),
  );
