/**
 * The joined view of an MCP Server: the record with the Connection it is
 * reached with and the plugin that offers it, and every word a screen writes
 * about it. Every screen that draws a server (Settings, the composer's menu,
 * a thread's lines) reads this, so none of them decides what "off" or
 * "failing" means on its own.
 */
import type { Connection, McpServer, PluginDetail } from "@hercule/contract";
import { describeConnectionTypeName } from "../connection-settings";
import { listConnectionTypes } from "../connection-types";
import { parsePluginId } from "../plugin-id";
import { formatCount } from "../threads/work-summary";
import { decideDisplayStatus, type McpServerDisplayStatus } from "./display-status";
import { readMcpServerOffers } from "./offers";

const STATUS_WORDS: Readonly<Record<McpServerDisplayStatus, string>> = {
  ready: "ready",
  checking: "checking",
  "needs-sign-in": "needs sign-in",
  unreachable: "unreachable",
  error: "error",
  off: "off",
};

/** One MCP Server, joined with what a screen needs to draw it. */
export interface McpServerView {
  readonly server: McpServer;
  /**
   * The plugin that offers the server, whose mark it wears. `null` for a
   * server added by URL: it has no plugin, so a screen draws the tools icon.
   */
  readonly pluginId: string | null;
  /** The Connection the server is reached with, or `undefined` when it is not in the list read. */
  readonly connection: Connection | undefined;
  /**
   * The label that tells two servers of one name apart: the Connection's label
   * for a plugin server (`undefined` without a Connection), the address's host
   * for a server added by URL.
   */
  readonly account: string | undefined;
  /** The display name of the Connection's type, such as "Sentry". */
  readonly typeName: string;
  /** The line under the server's name, such as "Sentry Connection · 13 tools". */
  readonly secondLine: string;
  readonly displayStatus: McpServerDisplayStatus;
  /** `displayStatus` as the one word a screen shows. */
  readonly statusWord: string;
  /** Whether the server needs the user: it needs sign-in, is unreachable or is in error. */
  readonly failing: boolean;
  /** The reason for a failing status in words a person can act on, for a tooltip. `null` when the server is not failing. */
  readonly statusDetail: string | null;
}

/**
 * Returns the views of `servers`, in the same order. A view carries the
 * Connection the server is reached with, found by its id, and the name of
 * that Connection's type from the plugins.
 *
 * Nothing here knows about projects: which projects name a server is a
 * Settings question (`buildMcpServerSettingsRows`), and the composer needs none.
 */
export const buildMcpServerViews = (
  servers: readonly McpServer[],
  connections: readonly Connection[],
  plugins: readonly PluginDetail[],
): McpServerView[] => {
  const offers = readMcpServerOffers(plugins);
  const types = listConnectionTypes(plugins);
  return servers.map((server) => {
    const { source } = server;
    const displayStatus = decideDisplayStatus(server);
    const failing =
      displayStatus === "needs-sign-in" ||
      displayStatus === "unreachable" ||
      displayStatus === "error";
    if (source.kind === "url") {
      const host = new URL(source.url).host;
      return {
        server,
        pluginId: null,
        connection: undefined,
        account: host,
        typeName: "",
        secondLine:
          server.checkedAt === null
            ? host
            : `${host} · ${formatCount(server.tools.length, "tool")}`,
        displayStatus,
        statusWord: STATUS_WORDS[displayStatus],
        failing,
        statusDetail: failing ? server.statusDetail : null,
      };
    }
    const connection = connections.find((each) => each.id === source.connectionId);
    const offer = offers.find((each) => each.contributionId === source.contributionId);
    const pluginId = parsePluginId(source.contributionId) ?? source.contributionId;
    const type = types.find((each) => each.type === (connection?.type ?? offer?.connectionType));
    const typeName =
      connection === undefined
        ? (type?.displayName ?? pluginId)
        : describeConnectionTypeName(connection, type);
    // Before the first check there is no tool count to give. A server whose
    // check found no tools has been checked, and says "0 tools".
    const secondLine =
      server.checkedAt === null
        ? `${typeName} Connection`
        : `${typeName} Connection · ${formatCount(server.tools.length, "tool")}`;
    return {
      server,
      pluginId,
      connection,
      account: connection?.label,
      typeName,
      secondLine,
      displayStatus,
      statusWord: STATUS_WORDS[displayStatus],
      failing,
      statusDetail: failing ? server.statusDetail : null,
    };
  });
};

/** The Connection to reconnect to bring a server back, and the label of the button that does it. */
export interface ReconnectTarget {
  readonly connectionId: string;
  /** Such as "Reconnect Sentry · webshop-prod". */
  readonly label: string;
}

/**
 * Returns what fixes a server that needs sign-in: its Connection's Reconnect
 * dialog, and the label every button that opens it wears. Returns `null` for
 * a server whose Connection is not in the list read.
 */
export const describeReconnect = (view: McpServerView): ReconnectTarget | null =>
  view.connection === undefined
    ? null
    : {
        connectionId: view.connection.id,
        label: `Reconnect ${view.typeName} · ${view.connection.label}`,
      };

/**
 * Checks whether "Check now" on the server's page is off: the server is being
 * checked already, or is switched off and so is not checked at all.
 */
export const isCheckDisabled = (view: McpServerView): boolean =>
  view.displayStatus === "checking" || view.displayStatus === "off";

/**
 * Returns the short word the Connection row of a server's page shows in the
 * failure colour while the server needs sign-in ("needs sign-in"), or `null`
 * when the server does not. It is the status word, not `statusDetail`: the
 * status band over the page already shows that sentence, and the server has no
 * time of the refusal to show instead.
 */
export const describeConnectionRowProblem = (view: McpServerView): string | null =>
  view.displayStatus === "needs-sign-in" ? view.statusWord : null;
