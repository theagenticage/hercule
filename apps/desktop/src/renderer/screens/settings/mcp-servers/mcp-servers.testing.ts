/**
 * The records the MCP server screens' tests share: a Sentry and a Linear
 * plugin that each offer a server, three Connections (a work and a hobby
 * Sentry account, and Linear), and the servers on them. A work and a hobby
 * Sentry server share the name `sentry`, which is the case the screens exist
 * to handle. Every id is a valid UUIDv7, because the integration tests send
 * these records through the client, which decodes them.
 *
 * client-core has fixtures of its own for its models, but its package does
 * not export them, so the app keeps the records its screens need.
 */
import type { Connection, McpServer, PluginDetail } from "@hercule/contract";

const AT = "2026-11-20T09:00:00.000Z";

/** Returns a plugin that declares the Connection type `<id>/<id>` and the MCP server `<id>/<id>` reached with it. */
const buildOfferingPlugin = (id: string, typeName: string): PluginDetail => ({
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

export const SENTRY_PLUGIN = buildOfferingPlugin("sentry", "Sentry");
export const LINEAR_PLUGIN = buildOfferingPlugin("linear", "Linear");
export const OFFERING_PLUGINS: readonly PluginDetail[] = [SENTRY_PLUGIN, LINEAR_PLUGIN];

/** Returns a connected Connection of `type`, labelled `label`, that acts as `displayName`. */
export const buildConnection = (
  id: string,
  type: string,
  label: string,
  displayName = label,
): Connection => ({
  id,
  type,
  label,
  displayName,
  status: "connected",
  labels: [],
  config: {},
  feedIntervals: {},
  credentials: [],
  createdAt: AT,
  updatedAt: AT,
});

export const SENTRY_WORK_CONNECTION = buildConnection(
  "01a06d02-8100-7000-8000-000000000001",
  "sentry/sentry",
  "work",
  "work@acme.example",
);
export const SENTRY_HOBBY_CONNECTION = buildConnection(
  "01a06d02-8100-7000-8000-000000000002",
  "sentry/sentry",
  "hobby",
);
export const LINEAR_CONNECTION = buildConnection(
  "01a06d02-8100-7000-8000-000000000003",
  "linear/linear",
  "acme",
);
export const OFFERING_CONNECTIONS: readonly Connection[] = [
  SENTRY_WORK_CONNECTION,
  SENTRY_HOBBY_CONNECTION,
  LINEAR_CONNECTION,
];

/**
 * Returns a ready server named `name`, reached with `connection` through the
 * plugin of the same name, with two tools listed at the last check.
 * `overrides` change any field.
 */
export const buildServer = (
  id: string,
  name: string,
  connection: Connection,
  overrides: Partial<McpServer> = {},
): McpServer => ({
  id,
  name,
  source: { kind: "plugin", contributionId: `${name}/${name}`, connectionId: connection.id },
  enabled: true,
  status: "ready",
  statusDetail: null,
  tools: [
    { name: "search_issues", description: "Searches issues." },
    { name: "get_issue", description: "Reads one issue." },
  ],
  checkedAt: AT,
  createdAt: AT,
  updatedAt: AT,
  ...overrides,
});

export const SENTRY_WORK_ID = "01a06d02-8200-7000-8000-000000000001";
export const SENTRY_HOBBY_ID = "01a06d02-8200-7000-8000-000000000002";
export const LINEAR_ID = "01a06d02-8200-7000-8000-000000000003";

export const SENTRY_WORK = buildServer(SENTRY_WORK_ID, "sentry", SENTRY_WORK_CONNECTION);
export const SENTRY_HOBBY = buildServer(SENTRY_HOBBY_ID, "sentry", SENTRY_HOBBY_CONNECTION);
export const LINEAR = buildServer(LINEAR_ID, "linear", LINEAR_CONNECTION);
