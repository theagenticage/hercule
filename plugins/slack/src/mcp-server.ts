import type { McpServerContribution } from "@hercule/plugin-host";
import { SLACK_CONNECTION_TYPE, SLACK_MCP_ORIGIN } from "./connection-type";

const SLACK_MCP_URL = `${SLACK_MCP_ORIGIN}/mcp`;

/**
 * Builds the call to Slack's MCP server from a Slack Connection's decoded
 * credentials. Returns the server's URL and an `Authorization: Bearer` header
 * with the Connection's `accessToken`.
 *
 * It never throws. When the credentials hold no token it returns no
 * `Authorization` header.
 */
const buildUpstreamRequest: McpServerContribution["buildUpstreamRequest"] = ({ credentials }) => {
  const token = credentials["accessToken"];
  return {
    url: SLACK_MCP_URL,
    headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
  };
};

export const slackMcpServer: McpServerContribution = {
  id: "slack",
  displayName: "Slack",
  description:
    "Search and read Slack messages, channels, canvases and files, and send messages, as the user who connected.",
  connectionType: SLACK_CONNECTION_TYPE,
  origin: SLACK_MCP_ORIGIN,
  buildUpstreamRequest,
};
