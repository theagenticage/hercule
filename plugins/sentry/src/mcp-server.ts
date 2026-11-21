import type { McpServerContribution } from "@hercule/plugin-host";
import { readToken } from "./api";
import { SENTRY_CONNECTION_TYPE } from "./connection-type";

/**
 * The origin of Sentry's hosted MCP server. It is not `sentry.io`: the MCP
 * server is a separate service that checks the token against the Sentry API.
 */
const SENTRY_MCP_ORIGIN = "https://mcp.sentry.dev";

/**
 * The server's URL. `disable-skills=project-management` leaves out the tools
 * that create and change projects and teams. The scopes of a Hercule Sentry
 * Connection do not cover them, so they would only fail when called: the query
 * drops 19 tools and 55 remain (measured 2026-11-20).
 */
const SENTRY_MCP_URL = `${SENTRY_MCP_ORIGIN}/mcp?disable-skills=project-management`;

/**
 * Builds the call to Sentry's MCP server from a Sentry Connection's decoded
 * credentials. Returns the server's URL and an `Authorization` header with the
 * Connection's token, from the pasted `token` field or the device flow's
 * `accessToken`.
 *
 * The scheme is `Sentry-Bearer`, not `Bearer`: the server accepts a Hercule
 * Sentry Connection's token only that way (a real call on 2026-11-20 got it
 * accepted, and refused plain `Bearer`).
 *
 * It never throws. The core calls it only with the credentials of a Connection
 * of this plugin's type, which always hold a token, so a Connection without
 * one is a state this function does not handle. It then returns no
 * `Authorization` header, and Sentry answers the call with its own 401, which
 * is the true statement of what is wrong. It does not invent a token or an
 * empty `Sentry-Bearer` value.
 */
const buildUpstreamRequest: McpServerContribution["buildUpstreamRequest"] = ({ credentials }) => {
  const token = readToken(credentials);
  return {
    url: SENTRY_MCP_URL,
    headers: token === undefined ? {} : { Authorization: `Sentry-Bearer ${token}` },
  };
};

export const sentryMcpServer: McpServerContribution = {
  id: "sentry",
  displayName: "Sentry",
  description: "Search and read Sentry issues, events and traces, and act on issues.",
  connectionType: SENTRY_CONNECTION_TYPE,
  origin: SENTRY_MCP_ORIGIN,
  buildUpstreamRequest,
};
