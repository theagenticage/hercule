/**
 * Tests the rules for what may leave the controller towards an outside MCP
 * server, and the fixed messages of its failures:
 *
 * - a URL may carry credentials only when it is `http` or `https`, exactly on
 *   the plugin's origin, and has no user name or password;
 * - every failure of the MCP client becomes one failure reason with a message
 *   that never holds what the server sent, and a 401 names the credentials it
 *   rejected;
 * - the backoff of an unreachable server.
 */
import { describe, expect, it } from "vitest";
import { McpClientError } from "effect/ai";
import { computeBackoffMillis } from "./state";
import { checkUrlOnOrigin, describeClientFailure } from "./upstream";

const ORIGIN = "https://mcp.example.com";

describe("checkUrlOnOrigin", () => {
  it("accepts a path and a query on the origin", () => {
    expect(checkUrlOnOrigin(ORIGIN, "https://mcp.example.com/mcp?x=1")).toBeUndefined();
  });

  it.each([
    ["another host", "https://evil.example.com/mcp"],
    ["another port", "https://mcp.example.com:8443/mcp"],
    ["another scheme", "http://mcp.example.com/mcp"],
    ["a user name", "https://user@mcp.example.com/mcp"],
    ["a password", "https://user:secret@mcp.example.com/mcp"],
    ["a scheme that is not http", "ftp://mcp.example.com/mcp"],
    ["a string that is not a URL", "not a url"],
    ["a host that only starts like the origin", "https://mcp.example.com.evil.test/mcp"],
  ])("refuses %s without sending", (_name, url) => {
    expect(checkUrlOnOrigin(ORIGIN, url)).toMatchObject({
      _tag: "UpstreamError",
      reason: "not-on-origin",
    });
  });
});

describe("describeClientFailure", () => {
  const fail = (reason: ConstructorParameters<typeof McpClientError.McpClientError>[0]["reason"]) =>
    new McpClientError.McpClientError({ reason });

  it("names the credentials that were rejected on a 401", () => {
    const failure = describeClientFailure(
      fail(new McpClientError.HttpError({ status: 401, description: "the secret body" })),
      "identity-1",
    );

    expect(failure).toMatchObject({ reason: "unauthorized", sentIdentity: "identity-1" });
    expect(failure.message).not.toContain("secret");
  });

  it("maps each kind of client failure to a reason, with a message that holds nothing the server sent", () => {
    const cases = [
      [new McpClientError.TransportError({ description: "ECONNREFUSED 10.0.0.1" }), "unreachable"],
      [new McpClientError.TimeoutError({ operation: "tools/list" }), "timeout"],
      [
        new McpClientError.LimitError({ description: "MCP message exceeds maxMessageBytes" }),
        "too-large",
      ],
      [new McpClientError.ProtocolError({ description: "a body the server wrote" }), "protocol"],
      [
        new McpClientError.HttpError({ status: 400, description: "a body the server wrote" }),
        "protocol",
      ],
      [new McpClientError.HttpError({ status: 500 }), "protocol"],
      [new McpClientError.HttpError({ status: 302 }), "protocol"],
      [new McpClientError.HttpError({ status: 400, code: -32022 }), "unsupported-revision"],
    ] as const;

    for (const [reason, expected] of cases) {
      const failure = describeClientFailure(fail(reason), undefined);
      expect(failure.reason, reason._tag).toBe(expected);
      expect(failure.message).not.toMatch(/ECONNREFUSED|10\.0\.0\.1|body the server wrote/);
    }
  });

  it("says that a redirect is not followed", () => {
    expect(
      describeClientFailure(fail(new McpClientError.HttpError({ status: 302 })), undefined).message,
    ).toBe("The server answered with a redirect (HTTP 302), which is not followed");
  });
});

describe("computeBackoffMillis", () => {
  it("waits 1 minute, 5, 15 and 60, and then an hour each time", () => {
    const minutes = [1, 2, 3, 4, 5, 20].map((failed) => computeBackoffMillis(failed) / 60_000);

    expect(minutes).toEqual([1, 5, 15, 60, 60, 60]);
  });
});
