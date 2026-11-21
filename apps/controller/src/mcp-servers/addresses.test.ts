import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import {
  buildDefaultServerName,
  findPluginOnOrigin,
  hideQueryValues,
  listQueryValues,
  parseServerAddress,
} from "./addresses";

interface Refusal {
  readonly code: string;
  readonly details: {
    readonly issues: ReadonlyArray<{
      readonly path: ReadonlyArray<string>;
      readonly message: string;
    }>;
  };
}

/** Runs an effect that must fail with a `Validation` error and returns its envelope. */
const refusalOf = async (effect: Effect.Effect<unknown, { readonly error: unknown }>) =>
  (await Effect.runPromise(Effect.flip(effect))).error as Refusal;

const read = (input: string) => Effect.runPromise(parseServerAddress(input));

describe("parseServerAddress", () => {
  it("returns the address as the URL parser writes it, with its key and its origin", async () => {
    expect(await read("  https://Mcp.Example.com:443/Mcp/?a=B  ")).toEqual({
      url: "https://mcp.example.com/Mcp/?a=B",
      normalizedUrl: "https://mcp.example.com/Mcp?a=B",
      origin: "https://mcp.example.com",
    });
  });

  it.each([
    ["https:example.com/mcp", "https://example.com/mcp"],
    ["https://example.com", "https://example.com/"],
    ["HTTP://Example.com:80/a/../mcp", "http://example.com/mcp"],
    ["https://example.com/mcp?", "https://example.com/mcp"],
    ["https://example.com/mcp/?", "https://example.com/mcp/"],
  ])("writes %s as the address %s, which requests go to", async (input, written) => {
    expect((await read(input)).url).toBe(written);
  });

  it("gives an address with a bare ? the key of the same address without it", async () => {
    expect((await read("https://example.com/mcp?")).normalizedUrl).toBe(
      (await read("https://example.com/mcp")).normalizedUrl,
    );
  });

  it.each([
    ["https://a.com", "https://a.com"],
    ["https://a.com/", "https://a.com"],
    ["HTTPS://A.COM:443", "https://a.com"],
    ["http://a.com:80/x/", "http://a.com/x"],
    ["https://x.com/mcp/", "https://x.com/mcp"],
    ["https://x.com/mcp", "https://x.com/mcp"],
    ["https://x.com/a/../mcp", "https://x.com/mcp"],
    ["https://x.com:8443/mcp", "https://x.com:8443/mcp"],
  ])("gives %s the key %s", async (input, key) => {
    expect((await read(input)).normalizedUrl).toBe(key);
  });

  it("keeps the case of the path and the query byte for byte, so they tell servers apart", async () => {
    const lower = (await read("https://x.com/mcp?token=abc")).normalizedUrl;
    expect((await read("https://x.com/MCP?token=abc")).normalizedUrl).not.toBe(lower);
    expect((await read("https://x.com/mcp?token=ABC")).normalizedUrl).not.toBe(lower);
    expect((await read("https://x.com/mcp?b=1&a=2")).normalizedUrl).not.toBe(
      (await read("https://x.com/mcp?a=2&b=1")).normalizedUrl,
    );
  });

  it.each([
    ["https://mcp.sentry.dev./mcp", "https://mcp.sentry.dev/mcp"],
    ["https://mcp.sentry.dev.:8443/mcp", "https://mcp.sentry.dev:8443/mcp"],
    ["https://MCP.Sentry.Dev./mcp/", "https://mcp.sentry.dev/mcp"],
  ])("gives %s the key %s: a trailing dot on the host is the same host", async (input, key) => {
    const address = await read(input);
    expect(address.normalizedUrl).toBe(key);
    expect(new URL(address.url).hostname).toBe(new URL(key).hostname);
    expect(address.origin).toBe(new URL(key).origin);
  });

  it("folds a percent-escaped unreserved character in the path, in the key and in the address", async () => {
    const address = await read("https://x.com/%6Dcp/%41%2d%2E%5f%7e/%39");
    expect(address.url).toBe("https://x.com/mcp/A-._~/9");
    expect(address.normalizedUrl).toBe("https://x.com/mcp/A-._~/9");
  });

  it("keeps every other escape in the path, with its hex digits in upper case", async () => {
    const address = await read("https://x.com/a%2fb/%e2%82%ac/%20/%25");
    expect(address.url).toBe("https://x.com/a%2Fb/%E2%82%AC/%20/%25");
    expect(address.normalizedUrl).toBe("https://x.com/a%2Fb/%E2%82%AC/%20/%25");
  });

  it("leaves the escapes in the query as they are", async () => {
    expect((await read("https://x.com/mcp?a=%6d%2f")).normalizedUrl).toBe(
      "https://x.com/mcp?a=%6d%2f",
    );
  });

  it("does not fold repeated slashes, and removes exactly one trailing slash", async () => {
    expect((await read("https://x.com/mcp//")).normalizedUrl).toBe("https://x.com/mcp/");
    expect((await read("https://x.com//mcp")).normalizedUrl).toBe("https://x.com//mcp");
    expect((await read("https://x.com/mcp//")).normalizedUrl).not.toBe(
      (await read("https://x.com/mcp")).normalizedUrl,
    );
  });

  it("keeps the trailing slash in the address that requests go to", async () => {
    expect((await read("https://api.githubcopilot.com/mcp/")).url).toBe(
      "https://api.githubcopilot.com/mcp/",
    );
  });

  it.each([
    ["text that is no address", "mcp.example.com", "This is not an address"],
    ["another scheme", "ftp://example.com/mcp", "must start with http:// or https://"],
    ["a host and port with no scheme", "localhost:3000/mcp", "must start with http:// or https://"],
    ["a user name", "https://me@example.com/mcp", "user name or a password"],
    ["a password", "https://me:secret@example.com/mcp", "user name or a password"],
    ["a fragment", "https://example.com/mcp#top", "#fragment"],
    ["an empty fragment", "https://example.com/mcp#", "#fragment"],
  ])("refuses %s on source.url, and says what to give instead", async (_what, input, words) => {
    const error = await refusalOf(parseServerAddress(input));
    expect(error.code).toBe("validation");
    expect(error.details.issues).toHaveLength(1);
    expect(error.details.issues[0]!.path).toEqual(["source", "url"]);
    expect(error.details.issues[0]!.message).toContain(words);
  });

  it("never repeats a password in its refusal", async () => {
    const error = await refusalOf(parseServerAddress("https://me:hunter2@example.com/mcp"));
    expect(JSON.stringify(error)).not.toContain("hunter2");
  });
});

describe("buildDefaultServerName", () => {
  const nameOf = async (input: string) =>
    Effect.runPromise(buildDefaultServerName(await read(input)));

  it.each([
    ["https://mcp.notion.com/mcp", "notion"],
    ["https://www.example.com", "example"],
    ["https://api.githubcopilot.com/mcp/", "githubcopilot"],
    ["https://mcp.api.www.linear.app/sse", "linear"],
    ["https://My-Server.example.com", "my_server"],
    ["https://example.com", "example"],
    ["http://localhost:8080/mcp", "localhost"],
    // An IP address has no name in it: its first label is the name when it passes the rule.
    ["http://192.168.0.1/mcp", "192"],
    ["http://[::1]:3000/mcp", "1"],
  ])("makes %s the name %s", async (input, name) => {
    expect(await nameOf(input)).toBe(name);
  });

  it("cuts the label to 16 characters and trims the underscore the cut leaves", async () => {
    expect(await nameOf("https://abcdefghijklmnopqrstuvwxyz.example.com")).toBe("abcdefghijklmnop");
    expect(await nameOf("https://abcdefghijklmno-pqrs.example.com")).toBe("abcdefghijklmno");
  });

  it.each([
    ["a host that is hercule", "https://hercule.example.com"],
    ["a host with no label left", "https://api"],
  ])("refuses %s on source.name, and tells the user to give a name", async (_what, input) => {
    const error = await refusalOf(buildDefaultServerName(await read(input)));
    expect(error.code).toBe("validation");
    expect(error.details.issues[0]!.path).toEqual(["source", "name"]);
    expect(error.details.issues[0]!.message).toContain(
      "Give the server a name of your own with --name",
    );
  });
});

describe("findPluginOnOrigin", () => {
  const contributions = [
    { id: "a/a", origin: "https://mcp.a.com" },
    { id: "b/b", origin: "https://mcp.b.com:8443" },
    { id: "c/c", origin: "https://mcp.b.com:8443" },
  ];

  it("returns the first contribution whose origin is the origin", () => {
    expect(findPluginOnOrigin("https://mcp.b.com:8443", contributions)?.id).toBe("b/b");
  });

  it("finds the plugin for an address whose host ends in a dot", async () => {
    const address = await read("https://mcp.a.com./mcp");
    expect(findPluginOnOrigin(address.origin, contributions)?.id).toBe("a/a");
  });

  it("matches the whole origin: a port, a scheme and a host all count", () => {
    for (const origin of [
      "https://mcp.b.com",
      "http://mcp.a.com",
      "https://a.com",
      "https://mcp.a.com:8443",
    ]) {
      expect(findPluginOnOrigin(origin, contributions), origin).toBeUndefined();
    }
  });
});

describe("hideQueryValues", () => {
  it("keeps every query parameter's name and hides its value", () => {
    expect(hideQueryValues("https://mcp.x.com/mcp?api_key=K&org=o&flag")).toBe(
      "https://mcp.x.com/mcp?api_key=…&org=…&flag",
    );
  });

  it("returns an address with no query as it is", () => {
    expect(hideQueryValues("https://mcp.x.com/mcp")).toBe("https://mcp.x.com/mcp");
  });
});

describe("listQueryValues", () => {
  it("lists each value as written and decoded, and leaves out empty ones", () => {
    expect(listQueryValues("https://x.com/mcp?a=p%40ss&b=&c=plain")).toEqual([
      "p%40ss",
      "p@ss",
      "plain",
    ]);
  });
});
