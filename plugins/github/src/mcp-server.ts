import type { McpServerContribution } from "@hercule/plugin-host";
import { readToken } from "./api";
import { GITHUB_CONNECTION_TYPE } from "./connection-type";

/** The origin of GitHub's hosted MCP server. It is not `api.github.com`: it is the Copilot API host. */
const GITHUB_MCP_ORIGIN = "https://api.githubcopilot.com";

const GITHUB_MCP_URL = `${GITHUB_MCP_ORIGIN}/mcp/`;

/**
 * The toolsets the server is asked for in the `X-MCP-Toolsets` header: the
 * ones where the Connection's device flow scopes (`repo`, `read:org`,
 * `notifications`, `workflow`) cover every tool, after the tools named in
 * `GITHUB_MCP_EXCLUDED_TOOLS` are excluded. A tool that needs a scope the
 * token lacks makes GitHub answer with an OAuth scope challenge, which the
 * gateway cannot answer, so a toolset with such tools is kept out of the list
 * rather than left to fail.
 *
 * Read from github/github-mcp-server at commit
 * 9a72d8d38fec18c207cd924b33aa0eb3e186252c on 2026-11-21: `pkg/github/tools.go`
 * for the toolset ids, and for each tool the scopes it declares (listed under
 * "OAuth Challenge Scopes" in that repository's README). `repo` includes
 * `security_events`, so the code security, secret protection, Dependabot and
 * security advisory toolsets are covered.
 *
 * Left out, and why:
 * - `gists` (`gist`), `projects` (`project`, `read:project`) and `governance`
 *   (`admin:org`, `admin:enterprise`, `read:enterprise`): scopes the Connection
 *   does not have.
 * - `copilot`, `copilot_automations`, `copilot_issue_intents` and
 *   `copilot_spaces`: they need a Copilot subscription, not a scope.
 * - `github_support_docs_search`: a remote-only toolset whose tools' scopes
 *   are not declared in that repository.
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

/**
 * The tools sent in the `X-MCP-Exclude-Tools` header. GitHub removes them even
 * when their toolset is enabled (documented in `docs/server-configuration.md`
 * of github/github-mcp-server, section "Excluding Specific Tools").
 *
 * `repos` is kept, because reading files, commits and branches is its main
 * use. Its `delete_repository` needs `delete_repo`, which the Connection does
 * not have, so it is excluded by name.
 */
const GITHUB_MCP_EXCLUDED_TOOLS = "delete_repository";

/**
 * Builds the call to GitHub's MCP server from a GitHub Connection's decoded
 * credentials. Returns the server's URL, an `Authorization` header with the
 * Connection's token (the pasted `pat`, or the device flow's `accessToken`),
 * the `X-MCP-Toolsets` header with the toolsets the device flow's scopes
 * cover, and the `X-MCP-Exclude-Tools` header with the tools to leave out of
 * them.
 *
 * The toolsets are the same for every token, because this function is pure and
 * cannot ask GitHub which scopes a pasted token has. A pasted token whose
 * scopes do not cover a tool in the list gets that tool's own failure when the
 * tool is called.
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
