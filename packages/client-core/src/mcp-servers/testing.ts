/**
 * Test fixtures for the MCP server models: a Sentry plugin and a Linear
 * plugin, three Connections (a work and a hobby Sentry account, and Linear),
 * and the servers on them. A work and a hobby Sentry server share the name
 * `sentry`, which is the case the models exist to handle.
 */
import type { Connection, McpServer, PluginDetail } from "@hercule/contract";
import { buildMcpServerViews, type McpServerView } from "./views";

const AT = "2026-11-20T09:00:00.000Z";

/** Returns a plugin that declares the Connection type `<id>/<id>` and the MCP server `<id>/<id>` reached with it. */
const buildPlugin = (id: string, typeName: string): PluginDetail => ({
  id,
  displayName: typeName,
  hostApi: 1,
  capabilities: ["connections", "mcp-servers"],
  enabled: true,
  status: { _tag: "active" },
  config: {},
  contributions: [
    {
      extensionPoint: "connection-type",
      id: `${id}/${id}`,
      definition: { type: `${id}/${id}`, displayName: typeName, setup: [] },
    },
    {
      extensionPoint: "mcp-server",
      id: `${id}/${id}`,
      definition: {
        displayName: typeName,
        description: `The ${typeName} MCP server.`,
        connectionType: `${id}/${id}`,
        origin: `https://mcp.${id}.example`,
      },
    },
  ],
  intake: { eventKinds: [], signalKinds: [] },
  entityKinds: [],
});

export const SENTRY_PLUGIN = buildPlugin("sentry", "Sentry");
export const LINEAR_PLUGIN = buildPlugin("linear", "Linear");
export const PLUGINS: readonly PluginDetail[] = [SENTRY_PLUGIN, LINEAR_PLUGIN];

/** Returns a connected Connection of `type` with `label`. */
export const buildConnection = (id: string, type: string, label: string): Connection => ({
  id,
  type,
  label,
  displayName: label,
  status: "connected",
  labels: [],
  config: {},
  feedIntervals: {},
  credentials: [],
  createdAt: AT,
  updatedAt: AT,
});

export const SENTRY_WORK_CONNECTION = buildConnection("c-work", "sentry/sentry", "work");
export const SENTRY_HOBBY_CONNECTION = buildConnection("c-hobby", "sentry/sentry", "hobby");
export const LINEAR_CONNECTION = buildConnection("c-linear", "linear/linear", "acme");
export const CONNECTIONS: readonly Connection[] = [
  SENTRY_WORK_CONNECTION,
  SENTRY_HOBBY_CONNECTION,
  LINEAR_CONNECTION,
];

/**
 * Returns a ready server named `name`, reached with the Connection
 * `connectionId` through the plugin of the same name, with two tools that
 * were listed at the last check. `overrides` change any field.
 */
export const buildServer = (
  id: string,
  name: string,
  connectionId: string,
  overrides: Partial<McpServer> = {},
): McpServer => ({
  id,
  name,
  source: { kind: "plugin", contributionId: `${name}/${name}`, connectionId },
  enabled: true,
  status: "ready",
  statusDetail: null,
  tools: [
    { name: "search", description: "Searches." },
    { name: "read", description: "Reads." },
  ],
  checkedAt: AT,
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});

export const SENTRY_WORK = buildServer("s-work", "sentry", "c-work");
export const SENTRY_HOBBY = buildServer("s-hobby", "sentry", "c-hobby");
export const LINEAR = buildServer("s-linear", "linear", "c-linear");

/** Returns the views of `servers` on the fixture Connections and plugins. */
export const buildViews = (servers: readonly McpServer[]): McpServerView[] =>
  buildMcpServerViews(servers, CONNECTIONS, PLUGINS);
