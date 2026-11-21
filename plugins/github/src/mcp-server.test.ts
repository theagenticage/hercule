import { describe, expect, it } from "vitest";
import { githubMcpServer } from "./mcp-server";

const MCP_URL = "https://api.githubcopilot.com/mcp/";

/** Reads the toolsets the request asks for, as a list. */
const readToolsets = (headers: Record<string, string>): ReadonlyArray<string> =>
  (headers["X-MCP-Toolsets"] ?? "").split(",");

describe("GitHub's MCP server request", () => {
  it.each([
    ["a pasted token", { pat: "pasted" }, "pasted"],
    ["a device flow token", { accessToken: "device" }, "device"],
    ["both, preferring the pasted token", { accessToken: "device", pat: "pasted" }, "pasted"],
  ])("sends %s as a Bearer header", (_name, credentials, token) => {
    const { url, headers } = githubMcpServer.buildUpstreamRequest({ credentials, config: {} });
    expect(url).toBe(MCP_URL);
    expect(headers["Authorization"]).toBe(`Bearer ${token}`);
  });

  it("sends no Authorization header when the credentials hold no token, and does not throw", () => {
    const { url, headers } = githubMcpServer.buildUpstreamRequest({ credentials: {}, config: {} });
    expect(url).toBe(MCP_URL);
    expect(headers).not.toHaveProperty("Authorization");
    expect(headers).toHaveProperty("X-MCP-Toolsets");
  });

  it("asks only for toolsets the device flow's scopes cover", () => {
    const { headers } = githubMcpServer.buildUpstreamRequest({
      credentials: { accessToken: "device" },
      config: {},
    });
    expect(readToolsets(headers)).toEqual([
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
    ]);
  });

  it("leaves out the toolsets that need a scope the Connection lacks or a Copilot subscription", () => {
    const { headers } = githubMcpServer.buildUpstreamRequest({ credentials: {}, config: {} });
    const toolsets = readToolsets(headers);
    for (const left of ["gists", "projects", "governance"]) {
      expect(toolsets).not.toContain(left);
    }
    expect(toolsets.filter((name) => name.startsWith("copilot"))).toEqual([]);
  });

  it("builds a URL on its declared origin", () => {
    const { url } = githubMcpServer.buildUpstreamRequest({ credentials: {}, config: {} });
    expect(new URL(url).origin).toBe(githubMcpServer.origin);
  });
});
