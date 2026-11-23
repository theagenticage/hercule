import { describe, expect, it } from "vitest";
import type { McpServer } from "@hercule/contract";
import { findReplaceCandidates } from "./replace";
import { SENTRY_WORK, buildServer } from "./testing";

const urlServer = (id: string, name: string, url: string): McpServer =>
  buildServer(id, name, "", { source: { kind: "url", url, signIn: "none", signInOffered: null } });

const OFFER = { origin: "https://mcp.sentry.example" };

describe("findReplaceCandidates", () => {
  it("returns the servers added by URL on the offer's origin, in the order given", () => {
    const first = urlServer("s-1", "one", "https://mcp.sentry.example/mcp");
    const second = urlServer("s-2", "two", "https://mcp.sentry.example/sse?team=a");

    expect(
      findReplaceCandidates(OFFER, [
        first,
        urlServer("s-other", "other", "https://mcp.other.example/mcp"),
        SENTRY_WORK,
        second,
      ]),
    ).toEqual([first, second]);
  });

  it("tells ports and schemes apart, and ignores the case of the host and a default port", () => {
    const servers = [
      urlServer("s-port", "port", "https://mcp.sentry.example:8443/mcp"),
      urlServer("s-http", "http", "http://mcp.sentry.example/mcp"),
      urlServer("s-default", "default", "https://MCP.Sentry.example:443/mcp"),
    ];

    expect(findReplaceCandidates(OFFER, servers).map((server) => server.id)).toEqual(["s-default"]);
    expect(
      findReplaceCandidates({ origin: "https://mcp.sentry.example:8443" }, servers).map(
        (server) => server.id,
      ),
    ).toEqual(["s-port"]);
  });

  it("returns none when no server was added by URL, or the origin is not an address", () => {
    expect(findReplaceCandidates(OFFER, [SENTRY_WORK])).toEqual([]);
    expect(
      findReplaceCandidates({ origin: "not an origin" }, [
        urlServer("s-1", "one", "https://mcp.sentry.example/mcp"),
      ]),
    ).toEqual([]);
  });
});
