import type { McpServerContribution } from "@hercule/plugin-host";
import { readToken } from "./api";
import { GITHUB_CONNECTION_TYPE } from "./connection-type";

/** The origin of GitHub's hosted MCP server. It is not `api.github.com`: it is the Copilot API host. */
const GITHUB_MCP_ORIGIN = "https://api.githubcopilot.com";

const GITHUB_MCP_URL = `${GITHUB_MCP_ORIGIN}/mcp/`;

/**
 * The toolsets sent in the `X-MCP-Toolsets` header: the ones whose tools the
 * Connection's device flow scopes (`repo`, `read:org`, `notifications`,
 * `workflow`) all cover.
 *
 * Pinned to github/github-mcp-server at commit
 * 9a72d8d38fec18c207cd924b33aa0eb3e186252c (2026-11-21): the toolset ids in
 * `pkg/github/tools.go` and the scopes each tool declares.
 *
 * `delete_repository` is excluded by name (`GITHUB_MCP_EXCLUDED_TOOLS`)
 * because it needs `delete_repo`, which the Connection lacks. GitHub applies
 * `X-MCP-Exclude-Tools` after the toolsets, so `repos` stays in the list.
 *
 * A pasted token gets the same list, because `buildUpstreamRequest` is pure
 * and cannot ask GitHub which scopes the token has. A tool its scopes do not
 * cover fails as that call's own answer.
 */
const GITHUB_MCP_TOOLSETS = [
  "actions",
  "code_quality",
  "code_security",
  "context",
  "dependabot",
  "discussions",
  "git",
  "issues",
  "labels",
  "notifications",
  "orgs",
  "pull_requests",
  "repos",
  "secret_protection",
  "security_advisories",
  "stargazers",
  "users",
].join(",");

/** The tools sent in the `X-MCP-Exclude-Tools` header. See `GITHUB_MCP_TOOLSETS` for why. */
const GITHUB_MCP_EXCLUDED_TOOLS = "delete_repository";

/**
 * Builds the call to GitHub's MCP server from a GitHub Connection's decoded
 * credentials. Returns the server's URL, an `Authorization` header with the
 * Connection's token (the pasted `pat`, or the device flow's `accessToken`),
 * the `X-MCP-Toolsets` header with the toolsets the device flow's scopes
 * cover, and the `X-MCP-Exclude-Tools` header with the tools to leave out of
 * them.
 *
 * It never throws. When the credentials hold no token it returns no
 * `Authorization` header.
 */
const buildUpstreamRequest: McpServerContribution["buildUpstreamRequest"] = ({ credentials }) => {
  const token = readToken(credentials);
  return {
    url: GITHUB_MCP_URL,
    headers: {
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      "X-MCP-Toolsets": GITHUB_MCP_TOOLSETS,
      "X-MCP-Exclude-Tools": GITHUB_MCP_EXCLUDED_TOOLS,
    },
  };
};

export const githubMcpServer: McpServerContribution = {
  id: "github",
  displayName: "GitHub",
  description:
    "Search and read GitHub repositories, issues and pull requests, and act on issues, pull requests and workflows.",
  connectionType: GITHUB_CONNECTION_TYPE,
  origin: GITHUB_MCP_ORIGIN,
  buildUpstreamRequest,
};
