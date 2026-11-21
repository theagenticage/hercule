/**
 * The MCP world of the counts page (perf-counts.tsx, `?screen=mcp`): the
 * handlers of a stubbed controller that holds three plugins that offer MCP
 * servers, a Connection and a server on each, and one thread in webshop that
 * has all three servers. The Linear server needs sign-in, so the thread's `+`
 * carries the red dot, which is what makes the thread read the servers.
 *
 * The ids are valid UUIDs, because the page reads these records through the
 * client, which decodes them.
 */
import { buildErrorBody, type Handler } from "@hercule/client-core/testing";
import { buildPlugin } from "@hercule/client-core/mcp-servers/testing";
import { FIXTURE_THREADS } from "../app/fake-controller";
import {
  buildConnection,
  buildServer,
  LINEAR,
  LINEAR_CONNECTION,
  OFFERING_CONNECTIONS,
  OFFERING_PLUGINS,
  SENTRY_WORK,
} from "../screens/settings/mcp-servers/mcp-servers.testing";

const GITHUB_CONNECTION = buildConnection(
  "01a06d02-8100-7000-8000-000000000004",
  "github/github",
  "rogier",
);
const GITHUB = buildServer("01a06d02-8200-7000-8000-000000000004", "github", GITHUB_CONNECTION);

/** Linear's server, which needs sign-in. */
const LINEAR_SIGNED_OUT = { ...LINEAR, status: "needs-sign-in" } as const;

/** The three servers the thread has, by name. */
const SERVERS = [GITHUB, LINEAR_SIGNED_OUT, SENTRY_WORK];

/** The thread with three servers: "Bump the Bun pin", which is idle in webshop. */
export const MCP_THREAD = {
  ...FIXTURE_THREADS.bunPin,
  mcpServers: SERVERS.map((server) => ({
    mcpServerId: server.id,
    name: server.name,
    leftOut: null,
  })),
};

/** Returns the handlers that answer the reads of Settings > MCP servers, a server's page and the thread. */
export function buildMcpWorld(): Record<string, Handler> {
  const path = `/api/v1/sessions/${MCP_THREAD.id}`;
  return {
    "GET /api/v1/plugins": {
      body: [...OFFERING_PLUGINS, buildPlugin("github", "GitHub")],
    },
    "GET /api/v1/connections": {
      body: {
        items: [
          ...OFFERING_CONNECTIONS.filter((each) => each !== LINEAR_CONNECTION),
          LINEAR_CONNECTION,
          GITHUB_CONNECTION,
        ],
      },
    },
    "GET /api/v1/settings": { body: { controller: {}, user: { "thread.mcpServerIds": [] } } },
    "GET /api/v1/mcp-servers": { body: { items: SERVERS } },
    ...Object.fromEntries(
      SERVERS.map((server) => [`GET /api/v1/mcp-servers/${server.id}`, { body: server }]),
    ),
    [`GET ${path}`]: { body: MCP_THREAD },
    [`GET ${path}/subagents`]: { body: { items: [] } },
    [`GET ${path}/transcript`]: { body: { items: [] } },
    [`GET ${path}/inputs`]: { body: { items: [] } },
    [`GET ${path}/skills`]: { body: { items: [], skipped: [] } },
    "GET /api/v1/mcp-servers/unknown": {
      status: 404,
      body: buildErrorBody("not_found", "no server"),
    },
  };
}
