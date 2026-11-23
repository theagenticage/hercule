/**
 * The joined view of an MCP Server: the record with the Connection it is
 * reached with and the plugin that offers it, and every word a screen writes
 * about it. Every screen that draws a server (Settings, the composer's menu,
 * a thread's lines) reads this, so none of them decides what "off" or
 * "failing" means on its own.
 */
import type { Connection, McpServer, PluginDetail } from "@hercule/contract";
import { describeConnectionTypeName } from "../connection-settings";
import { listConnectionTypes, type ConnectionType } from "../connection-types";
import { parsePluginId } from "../plugin-id";
import { formatCount } from "../threads/work-summary";
import { decideDisplayStatus } from "./display-status";
import { describeOfferAddress, readMcpServerOffers, type McpServerOffer } from "./offers";
import { MCP_SERVER_STATUS_FACTS, type McpServerDisplayStatus } from "./status";

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
   * for a plugin server (`undefined` without a Connection), the whole address
   * for a server added by URL. The host alone would not tell apart two
   * addresses on one host.
   */
  readonly account: string | undefined;
  /** The display name of the Connection's type, such as "Sentry". */
  readonly typeName: string;
  /**
   * The line under the server's name: "Sentry Connection · 13 tools" for a
   * plugin server, "https://mcp.example.com/mcp · 13 tools" for a server
   * added by URL, whose address is written whole.
   */
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
): McpServerView[] =>
  buildMcpServerViewsFromOffers({
    servers,
    connections,
    offers: readMcpServerOffers(plugins),
    types: listConnectionTypes(plugins),
  });

/**
 * Returns what `buildMcpServerViews` returns, from the offers
 * (`readMcpServerOffers`) and the Connection types (`listConnectionTypes`)
 * the plugins give, which a caller that already decoded them passes in
 * instead of decoding them again.
 */
export const buildMcpServerViewsFromOffers = ({
  servers,
  connections,
  offers,
  types,
}: {
  readonly servers: readonly McpServer[];
  readonly connections: readonly Connection[];
  readonly offers: readonly McpServerOffer[];
  readonly types: readonly ConnectionType[];
}): McpServerView[] =>
  servers.map((server) => {
    const { source } = server;
    const connection =
      source.kind === "plugin"
        ? connections.find((each) => each.id === source.connectionId)
        : undefined;
    const offer =
      source.kind === "plugin"
        ? offers.find((each) => each.contributionId === source.contributionId)
        : undefined;
    return buildMcpServerView(server, {
      connection,
      type: types.find((each) => each.type === (connection?.type ?? offer?.connectionType)),
    });
  });

/**
 * Returns the view of one server from the Connection it is reached with and
 * that Connection's type, which a caller that already matched them (Settings,
 * from its offer and Connection pair) passes in instead of matching again.
 * Both are `undefined` for a server added by URL, and where the list read has
 * no such Connection or the type is unknown.
 */
export const buildMcpServerView = (
  server: McpServer,
  {
    connection,
    type,
  }: {
    readonly connection: Connection | undefined;
    readonly type: ConnectionType | undefined;
  },
): McpServerView => {
  const { source } = server;
  const displayStatus = decideDisplayStatus(server);
  const { word: statusWord, failing } = MCP_SERVER_STATUS_FACTS[displayStatus];
  if (source.kind === "url") {
    return {
      server,
      pluginId: null,
      connection: undefined,
      account: source.url,
      typeName: "",
      secondLine:
        server.checkedAt === null
          ? source.url
          : `${source.url} · ${formatCount(server.tools.length, "tool")}`,
      displayStatus,
      statusWord,
      failing,
      statusDetail: failing ? server.statusDetail : null,
    };
  }
  const pluginId = parsePluginId(source.contributionId) ?? source.contributionId;
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
    statusWord,
    failing,
    statusDetail: failing ? server.statusDetail : null,
  };
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

/** What opens the sign-in of a server that needs one, and the label of the button that does it. */
export type SignInAction =
  /** A plugin's server: the Connection's own Reconnect dialog. */
  | ({ readonly kind: "reconnect" } & ReconnectTarget)
  /**
   * A server added by URL, which has no Connection: the sign-in dialog of
   * that server, with the browser first for a server that offers it and the
   * pasted token for every server.
   */
  | { readonly kind: "sign-in"; readonly mcpServerId: string; readonly label: "Sign in…" };

/**
 * Returns the button that fixes a server that needs sign-in, or `null` when
 * there is none (a plugin's server whose Connection is not in the list read).
 * The submenu's row, a thread's warning line and the page's band all read
 * this one function, so they offer the same button.
 *
 * A server added by URL gets the sign-in dialog, whatever it accepts.
 */
export const describeSignInAction = (view: McpServerView): SignInAction | null => {
  const { source } = view.server;
  if (source.kind === "plugin") {
    const reconnect = describeReconnect(view);
    return reconnect === null ? null : { kind: "reconnect", ...reconnect };
  }
  return { kind: "sign-in", mcpServerId: view.server.id, label: "Sign in…" };
};

/** What the heading of a server's page shows besides the name. */
export interface ServerPageFields {
  /** The address chip: a server added by URL shows its whole address, a plugin's server the address its plugin offers. `null` when the plugin no longer offers it. */
  readonly address: string | null;
  /** The account written beside the name: the Connection's label of a plugin's server, or `null` for a server added by URL, whose address is its account and shows as the chip. */
  readonly account: string | null;
}

/**
 * Returns the address and the account of a server's page from `view` and the
 * `plugins` that offer servers, so both apps decide them the same way.
 */
export const describeServerPageFields = (
  view: McpServerView,
  plugins: readonly PluginDetail[],
): ServerPageFields => {
  const { source } = view.server;
  if (source.kind === "url") return { address: source.url, account: null };
  const offer = readMcpServerOffers(plugins).find(
    (each) => each.contributionId === source.contributionId,
  );
  return {
    address: offer === undefined ? null : describeOfferAddress(offer.origin),
    account: view.account ?? null,
  };
};

/**
 * Returns the first chip of a server's page: "Added by URL", or "From the
 * Sentry plugin" for a plugin's server, whose plugin is named `pluginName`
 * (the view's Connection type when the caller has no plugin name).
 */
export const describeSourceChip = (view: McpServerView, pluginName?: string): string =>
  view.server.source.kind === "url"
    ? "Added by URL"
    : `From the ${pluginName ?? view.typeName} plugin`;

/**
 * Returns the sentence under "Remove server" on a server's page: what
 * deleting it takes with it. A server added by URL takes its sign-in too,
 * and a plugin's server leaves its Connection in place.
 */
export const describeRemoveEffect = (view: McpServerView): string => {
  const base = "Deletes the server";
  const projects = "Projects that name it stop naming it.";
  if (view.server.source.kind === "url") return `${base} and its sign-in. ${projects}`;
  return view.connection === undefined
    ? `${base}. ${projects}`
    : `${base}. ${projects} The Connection ${view.typeName} · ${view.connection.label} stays.`;
};

/** The Sign-in row on the page of a server added by URL. */
export interface SignInRow {
  /**
   * What the server holds: "None needed", "Not signed in" (the server needs a
   * sign-in it does not hold yet), "A token" or "OAuth".
   */
  readonly value: "None needed" | "Not signed in" | "A token" | "OAuth";
  /**
   * The row's button, or `null` for none: "Replace token…" while the server
   * holds a pasted token and does not need sign-in. A server that needs sign-in
   * has the status band's button instead, so the page draws one button only.
   * "Sign in again…" while the server holds an OAuth sign-in and does not need
   * sign-in. Both open the same dialog.
   */
  readonly action:
    | { readonly kind: "replace-token"; readonly label: "Replace token…" }
    | { readonly kind: "sign-in-again"; readonly label: "Sign in again…" }
    | null;
}

/** Returns the Sign-in row of a server added by URL, or `null` for a plugin's server, which has the Connection row instead. */
export const describeSignInRow = (view: McpServerView): SignInRow | null => {
  const { source } = view.server;
  if (source.kind === "plugin") return null;
  const needsSignIn = MCP_SERVER_STATUS_FACTS[view.displayStatus].needsSignIn;
  // A server that offers OAuth and was never signed in holds nothing yet, but
  // "None needed" would contradict the band saying it needs sign-in. The band
  // holds the page's one button, so the row has none.
  if (source.signIn === "none") {
    return { value: needsSignIn ? "Not signed in" : "None needed", action: null };
  }
  if (source.signIn === "oauth") {
    return {
      value: "OAuth",
      action: needsSignIn ? null : { kind: "sign-in-again", label: "Sign in again…" },
    };
  }
  return {
    value: "A token",
    action: needsSignIn ? null : { kind: "replace-token", label: "Replace token…" },
  };
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
  MCP_SERVER_STATUS_FACTS[view.displayStatus].needsSignIn ? view.statusWord : null;
