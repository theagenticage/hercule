/**
 * The rows of Settings > MCP servers, group "From your Connections": one for
 * each Connection whose plugin offers a server, switched on or off.
 */
import type { Connection, McpServer, PluginDetail, Project } from "@hercule/contract";
import { describeConnectionTypeName } from "../connection-settings";
import { listConnectionTypes } from "../connection-types";
import { formatNameList } from "../name-list";
import { joinOffersToServers, readMcpServerOffers, type McpServerOffer } from "./offers";
import { buildMcpServerView, type McpServerView } from "./views";

/** One row of the group "From your Connections". */
export interface McpServerSettingsRow {
  readonly offer: McpServerOffer;
  readonly connection: Connection;
  /** The server record's view, or `null` while the server is not switched on: no record exists yet, and the row has no page. */
  readonly view: McpServerView | null;
  /** The display name of the Connection's type, such as "Sentry". */
  readonly typeName: string;
  /** The server's name, or the name it will get when it is switched on. */
  readonly name: string;
  /** The line under the name. */
  readonly secondLine: string;
  /** The status as one word. A server with no record reads "off". */
  readonly statusWord: string;
  /** The projects whose lists name the server. Empty while it has no record. */
  readonly projects: readonly Project[];
}

/**
 * Returns the rows of "From your Connections": one for each Connection whose
 * type a plugin's MCP server contribution names, paired with that
 * contribution (a plugin that offers two servers on one Connection type gives
 * two rows). A row's server is the one whose source names both.
 *
 * The rows are ordered by the Connection type's name, then the Connection's
 * label, then the contribution, so the order never depends on the order the
 * controller listed the Connections in.
 */
export const buildMcpServerSettingsRows = ({
  servers,
  connections,
  plugins,
  projects,
}: {
  readonly servers: readonly McpServer[];
  readonly connections: readonly Connection[];
  readonly plugins: readonly PluginDetail[];
  readonly projects: readonly Project[];
}): McpServerSettingsRow[] => {
  const types = listConnectionTypes(plugins);
  // The offers are decoded once, and only the servers that belong to an offer get a view.
  const offers = readMcpServerOffers(plugins);
  const offered = joinOffersToServers(offers, servers, connections);
  return offered
    .map(({ offer, connection, server }) => {
      const type = types.find((each) => each.type === connection.type);
      // The view is built from the pair this row already holds, and its type
      // name is the row's, so nothing is matched or worked out a second time.
      const view = server === null ? null : buildMcpServerView(server, { connection, type });
      const typeName = view?.typeName ?? describeConnectionTypeName(connection, type);
      return {
        offer,
        connection,
        view,
        typeName,
        name: view?.server.name ?? offer.defaultName,
        secondLine: view?.secondLine ?? `${typeName} Connection · switch it on to see its tools`,
        statusWord: view?.statusWord ?? "off",
        projects:
          view === null
            ? []
            : projects.filter((project) => project.mcpServerIds.includes(view.server.id)),
      };
    })
    .toSorted(
      (a, b) =>
        a.typeName.localeCompare(b.typeName) ||
        a.connection.label.localeCompare(b.connection.label) ||
        a.offer.contributionId.localeCompare(b.offer.contributionId),
    );
};

/** What the "Projects" cell of a row shows. */
export type NamingProjects =
  | { readonly kind: "none"; readonly text: "None" }
  | { readonly kind: "tiles"; readonly projects: readonly Project[] }
  | { readonly kind: "count"; readonly text: string; readonly tooltip: string };

/**
 * Returns what the "Projects" cell shows for the projects that name a server:
 * "None", the tiles of one or two projects, or a count such as "3 projects"
 * with the names for its tooltip. Three tiles do not fit the column.
 */
export const describeNamingProjects = (projects: readonly Project[]): NamingProjects => {
  if (projects.length === 0) return { kind: "none", text: "None" };
  if (projects.length <= 2) return { kind: "tiles", projects };
  return {
    kind: "count",
    text: `${String(projects.length)} projects`,
    tooltip: formatNameList(
      projects.map((project) => project.name),
      "and",
    ),
  };
};
