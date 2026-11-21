/**
 * Fixtures for tests of the thread's MCP servers, in the composer's menu and
 * on the thread's lines: plugins that offer a server, the Connections they
 * are reached with, and the servers.
 *
 * Nine names exist, so a menu that lists at most eight has one left over.
 * Two servers are both named `sentry` (a work and a hobby account), the case
 * the menu handles with one row and a choice of account.
 */
import { screen, within } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";
import type { Connection, McpServer, PluginDetail, Session } from "@hercule/contract";
import {
  buildConnection,
  buildPlugin,
  buildServer,
} from "@hercule/client-core/mcp-servers/testing";
import type { Handler } from "./testing";

const makeId = (kind: string, n: number): string =>
  `0199c0ff-${kind.repeat(4)}-7000-8000-${String(n).padStart(12, "0")}`;

/** The names of the servers, in the order the stub controller lists them. `sentry` comes twice, for two accounts. */
const SLUGS = [
  "sentry",
  "sentry",
  "linear",
  "notion",
  "github",
  "grafana",
  "context7",
  "datadog",
  "stripe",
  "figma",
] as const;

const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  sentry: "Sentry",
  linear: "Linear",
  notion: "Notion",
  github: "GitHub",
  grafana: "Grafana",
  context7: "Context7",
  datadog: "Datadog",
  stripe: "Stripe",
  figma: "Figma",
};

export const MCP_PLUGINS: readonly PluginDetail[] = [...new Set(SLUGS)].map((slug) =>
  buildPlugin(slug, DISPLAY_NAMES[slug]!),
);

const LABELS = ["work", "hobby", "acme", "wiki", "rogier", "ops", "docs", "prod", "shop", "design"];

export const MCP_CONNECTIONS: readonly Connection[] = SLUGS.map((slug, index) =>
  buildConnection(
    makeId("c", index + 1),
    `${slug}/${slug}`,
    LABELS[index]!,
    `acct:${LABELS[index]}`,
  ),
);

/** The server of the index in `SLUGS`, ready and on. */
const buildServerAt = (index: number, overrides: Partial<McpServer> = {}): McpServer =>
  buildServer(makeId("5", index + 1), SLUGS[index]!, MCP_CONNECTIONS[index]!.id, overrides);

export const S_SENTRY_WORK = buildServerAt(0);
export const S_SENTRY_HOBBY = buildServerAt(1);
/** Linear's token was revoked: the one server that needs sign-in. */
export const S_LINEAR = buildServerAt(2, {
  status: "needs-sign-in",
  statusDetail: "Linear revoked the token",
});
export const S_NOTION = buildServerAt(3);
export const S_GITHUB = buildServerAt(4);
export const S_GRAFANA = buildServerAt(5);
export const S_CONTEXT7 = buildServerAt(6);
export const S_DATADOG = buildServerAt(7);
export const S_STRIPE = buildServerAt(8);
/** Switched off in Settings, so the menu offers it only to a thread that has it. */
export const S_FIGMA = buildServerAt(9, { enabled: false });

export const MCP_SERVERS: readonly McpServer[] = [
  S_SENTRY_WORK,
  S_SENTRY_HOBBY,
  S_LINEAR,
  S_NOTION,
  S_GITHUB,
  S_GRAFANA,
  S_CONTEXT7,
  S_DATADOG,
  S_STRIPE,
  S_FIGMA,
];

/** The Connection `server` is reached with. */
export const findConnectionOf = (server: McpServer): Connection =>
  MCP_CONNECTIONS.find((connection) => connection.id === server.source.connectionId)!;

/** Returns the list of a Session: each server of `servers`, none left out. */
export const buildSessionServers = (servers: readonly McpServer[]): Session["mcpServers"] =>
  servers.map((server) => ({ mcpServerId: server.id, name: server.name, leftOut: null }));

/**
 * Returns the routes of a stub controller that holds `servers`, with the
 * Connections and the plugins that join them. `servers` is a function, so a
 * test can change what the controller holds and push a live nudge.
 */
export const buildMcpServerRoutes = (
  servers: () => readonly McpServer[] = () => MCP_SERVERS,
): Readonly<Record<string, Handler>> => ({
  "GET /api/v1/mcp-servers": () => ({ body: { items: servers() } }),
  "GET /api/v1/connections": { body: { items: MCP_CONNECTIONS } },
  "GET /api/v1/plugins": { body: MCP_PLUGINS },
});

/** Opens the composer's `+` menu and returns it. */
export const openPlusMenu = async (
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLElement> => {
  await user.click(await screen.findByRole("button", { name: /^Add to thread/ }));
  return screen.findByRole("dialog", { name: "Add to thread" });
};

/** Opens the `+` menu and its submenu "Servers of this thread", waits for its rows, and returns the submenu. */
export const openServersSubmenu = async (
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLElement> => {
  const menu = await openPlusMenu(user);
  await user.click(within(menu).getByRole("button", { name: /MCP servers/ }));
  const submenu = await screen.findByRole("dialog", { name: "Servers of this thread" });
  // The submenu's code and the servers load after the menu opens.
  await within(submenu).findByText("Servers of this thread");
  return submenu;
};

/** Returns the server names the submenu lists, top to bottom, each with whether its switch is on. */
export const readSubmenuSwitches = (
  submenu: HTMLElement,
): readonly { readonly name: string; readonly on: boolean }[] =>
  within(submenu)
    .getAllByRole("switch")
    .map((each) => ({
      name: each.getAttribute("aria-label")!.replace(/ in this thread$/, ""),
      on: each.getAttribute("aria-checked") === "true",
    }));
