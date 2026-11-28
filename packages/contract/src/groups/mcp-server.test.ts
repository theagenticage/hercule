import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { McpServerFinishSignInInput, McpServerStartSignInInput } from "./mcp-server";

const decodes = <S extends Schema.Codec<unknown, unknown>>(schema: S, input: unknown): boolean =>
  Effect.runSyncExit(Schema.decodeUnknownEffect(schema)(input))._tag === "Success";

describe("the redirect address of a sign-in", () => {
  it.each([
    "http://127.0.0.1:1/callback",
    "http://127.0.0.1:49152/callback",
    "http://127.0.0.1:65535/callback",
  ])("accepts %s", (redirectUri) => {
    expect(decodes(McpServerStartSignInInput, { redirectUri })).toBe(true);
  });

  it.each([
    ["a port above 65535", "http://127.0.0.1:65536/callback"],
    ["port 0", "http://127.0.0.1:0/callback"],
    ["a port with a leading zero", "http://127.0.0.1:08080/callback"],
    ["no port", "http://127.0.0.1/callback"],
    ["localhost", "http://localhost:8080/callback"],
    ["the IPv6 loopback", "http://[::1]:8080/callback"],
    ["another host", "http://127.0.0.2:8080/callback"],
    ["https", "https://127.0.0.1:8080/callback"],
    ["another path", "http://127.0.0.1:8080/cb"],
    ["a query", "http://127.0.0.1:8080/callback?x=1"],
    ["a fragment", "http://127.0.0.1:8080/callback#x"],
    ["user information", "http://user@127.0.0.1:8080/callback"],
    ["a trailing slash", "http://127.0.0.1:8080/callback/"],
  ])("refuses %s", (_name, redirectUri) => {
    expect(decodes(McpServerStartSignInInput, { redirectUri })).toBe(false);
  });
});

describe("what a sign-in finishes with", () => {
  it("accepts a query and a whole address", () => {
    expect(decodes(McpServerFinishSignInInput, { callbackQuery: "code=a&state=b" })).toBe(true);
    expect(
      decodes(McpServerFinishSignInInput, {
        callbackQuery: "http://127.0.0.1:8080/callback?code=a&state=b",
      }),
    ).toBe(true);
  });

  it("refuses an empty text", () => {
    expect(decodes(McpServerFinishSignInInput, { callbackQuery: "" })).toBe(false);
  });
});
