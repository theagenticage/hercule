import type { McpServerContribution } from "@hercule/plugin-host";
import { readToken } from "./api";
import { LINEAR_CONNECTION_TYPE } from "./connection-type";

/** The origin of Linear's hosted MCP server. It is not `api.linear.app`, which serves the GraphQL API. */
const LINEAR_MCP_ORIGIN = "https://mcp.linear.app";

const LINEAR_MCP_URL = `${LINEAR_MCP_ORIGIN}/mcp`;

/**
 * Builds the call to Linear's MCP server from a Linear Connection's decoded
 * credentials. Returns the server's URL and an `Authorization` header with the
 * Connection's token, from the redirect flow's `accessToken`, else from the
 * pasted `apiKey`.
 *
 * Both kinds go as `Bearer <token>`. This differs from Linear's GraphQL API,
 * which refuses a personal API key sent with `Bearer`: Linear's MCP server
 * takes OAuth tokens and API keys alike in the `Authorization: Bearer` header
 * (https://linear.app/docs/mcp).
 *
 * It never throws. When the credentials hold no token it returns no
 * `Authorization` header.
 */
const buildUpstreamRequest: McpServerContribution["buildUpstreamRequest"] = ({ credentials }) => {
  const token = readToken(credentials);
  return {
    url: LINEAR_MCP_URL,
    headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
  };
};

export const linearMcpServer: McpServerContribution = {
  id: "linear",
  displayName: "Linear",
  description: "Search and read Linear issues, projects and documents, and create and update them.",
  connectionType: LINEAR_CONNECTION_TYPE,
  origin: LINEAR_MCP_ORIGIN,
  buildUpstreamRequest,
};
