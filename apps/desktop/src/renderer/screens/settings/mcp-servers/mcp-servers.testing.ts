/**
 * The records the MCP server screens' tests share: the Sentry and Linear
 * plugins of client-core's fixtures, three Connections (a work and a hobby
 * Sentry account, and Linear), and the servers on them. A work and a hobby
 * Sentry server share the name `sentry`, which is the case the screens exist
 * to handle. Every id is a valid UUIDv7, because the integration tests send
 * these records through the client, which decodes them; client-core's own
 * fixtures use short ids.
 */
import type { Connection, McpServer } from "@hercule/contract";
import {
  buildConnection,
  buildServer as buildServerOnConnectionId,
} from "@hercule/client-core/mcp-servers/testing";

export {
  buildConnection,
  LINEAR_PLUGIN,
  OFFERING_PLUGINS,
  SENTRY_PLUGIN,
} from "@hercule/client-core/mcp-servers/testing";

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
): McpServer =>
  buildServerOnConnectionId(id, name, connection.id, {
    tools: [
      { name: "search_issues", description: "Searches issues." },
      { name: "get_issue", description: "Reads one issue." },
    ],
    ...overrides,
  });

export const SENTRY_WORK_ID = "01a06d02-8200-7000-8000-000000000001";
export const SENTRY_HOBBY_ID = "01a06d02-8200-7000-8000-000000000002";
export const LINEAR_ID = "01a06d02-8200-7000-8000-000000000003";

export const SENTRY_WORK = buildServer(SENTRY_WORK_ID, "sentry", SENTRY_WORK_CONNECTION);
export const SENTRY_HOBBY = buildServer(SENTRY_HOBBY_ID, "sentry", SENTRY_HOBBY_CONNECTION);
export const LINEAR = buildServer(LINEAR_ID, "linear", LINEAR_CONNECTION);

/**
 * Returns a ready server added by URL, named `name`, at the address `url`,
 * with two tools listed at the last check, that holds no sign-in and was told
 * of none. `overrides` change any field, such as `source` for a token.
 */
export const buildUrlServer = (
  id: string,
  name: string,
  url: string,
  overrides: Partial<McpServer> = {},
): McpServer =>
  buildServer(id, name, SENTRY_WORK_CONNECTION, {
    source: { kind: "url", url, signIn: "none", signInOffered: null },
    ...overrides,
  });

export const DOCS_ID = "01a06d02-8200-7000-8000-000000000011";
export const NOTION_ID = "01a06d02-8200-7000-8000-000000000012";

/** A server added by URL, ready, with no sign-in. */
export const DOCS = buildUrlServer(DOCS_ID, "docs", "https://mcp.docs.example/mcp");
/** A server added by URL that holds a pasted token. */
export const NOTION = buildUrlServer(NOTION_ID, "notion", "https://mcp.notion.example/mcp", {
  source: {
    kind: "url",
    url: "https://mcp.notion.example/mcp",
    signIn: "token",
    signInOffered: "token",
  },
});
