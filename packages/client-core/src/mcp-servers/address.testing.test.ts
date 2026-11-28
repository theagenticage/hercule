/**
 * Pins the cases of the controller's address tests (`addresses.test.ts` in the
 * controller's `mcp-servers` folder) on the fake controller's copy of the
 * rules, so the fake refuses and merges the same spellings the controller does.
 */
import { describe, expect, it } from "vitest";
import { readServerAddress, type FakeServerAddress } from "./address.testing";

const read = (input: string): FakeServerAddress => {
  const reading = readServerAddress(input);
  if ("refusal" in reading) throw new Error(`refused: ${reading.refusal}`);
  return reading;
};

describe("readServerAddress", () => {
  it("returns the address as the URL parser writes it, with its key and its origin", () => {
    expect(read("  https://Mcp.Example.com:443/Mcp/?a=B  ")).toEqual({
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
  ])("writes %s as the address %s, which requests go to", (input, written) => {
    expect(read(input).url).toBe(written);
  });

  it("gives an address with a bare ? the key of the same address without it", () => {
    expect(read("https://example.com/mcp?").normalizedUrl).toBe(
      read("https://example.com/mcp").normalizedUrl,
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
  ])("gives %s the key %s", (input, key) => {
    expect(read(input).normalizedUrl).toBe(key);
  });

  it("keeps the case of the path and the query byte for byte, so they tell servers apart", () => {
    const lower = read("https://x.com/mcp?token=abc").normalizedUrl;
    expect(read("https://x.com/MCP?token=abc").normalizedUrl).not.toBe(lower);
    expect(read("https://x.com/mcp?token=ABC").normalizedUrl).not.toBe(lower);
    expect(read("https://x.com/mcp?b=1&a=2").normalizedUrl).not.toBe(
      read("https://x.com/mcp?a=2&b=1").normalizedUrl,
    );
  });

  it.each([
    ["https://mcp.sentry.dev./mcp", "https://mcp.sentry.dev/mcp"],
    ["https://mcp.sentry.dev.:8443/mcp", "https://mcp.sentry.dev:8443/mcp"],
    ["https://MCP.Sentry.Dev./mcp/", "https://mcp.sentry.dev/mcp"],
    ["https://mcp.sentry.dev../mcp", "https://mcp.sentry.dev/mcp"],
    ["https://mcp.sentry.dev...:8443/mcp", "https://mcp.sentry.dev:8443/mcp"],
  ])("gives %s the key %s: a trailing dot on the host is the same host", (input, key) => {
    const address = read(input);
    expect(address.normalizedUrl).toBe(key);
    expect(new URL(address.url).hostname).toBe(new URL(key).hostname);
    expect(address.origin).toBe(new URL(key).origin);
  });

  it("folds a percent-escaped unreserved character in the path, in the key and in the address", () => {
    const address = read("https://x.com/%6Dcp/%41%2d%2E%5f%7e/%39");
    expect(address.url).toBe("https://x.com/mcp/A-._~/9");
    expect(address.normalizedUrl).toBe("https://x.com/mcp/A-._~/9");
  });

  it("keeps every other escape in the path, with its hex digits in upper case", () => {
    const address = read("https://x.com/a%2fb/%e2%82%ac/%20/%25");
    expect(address.url).toBe("https://x.com/a%2Fb/%E2%82%AC/%20/%25");
    expect(address.normalizedUrl).toBe("https://x.com/a%2Fb/%E2%82%AC/%20/%25");
  });

  it("leaves the escapes in the query as they are", () => {
    expect(read("https://x.com/mcp?a=%6d%2f").normalizedUrl).toBe("https://x.com/mcp?a=%6d%2f");
  });

  it("does not fold repeated slashes, and removes exactly one trailing slash", () => {
    expect(read("https://x.com/mcp//").normalizedUrl).toBe("https://x.com/mcp/");
    expect(read("https://x.com//mcp").normalizedUrl).toBe("https://x.com//mcp");
    expect(read("https://x.com/mcp//").normalizedUrl).not.toBe(
      read("https://x.com/mcp").normalizedUrl,
    );
  });

  it("keeps the trailing slash in the address that requests go to", () => {
    expect(read("https://api.githubcopilot.com/mcp/").url).toBe(
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
  ])("refuses %s and says what to give instead", (_what, input, words) => {
    const reading = readServerAddress(input);
    expect("refusal" in reading && reading.refusal).toContain(words);
  });

  it("never repeats a password in its refusal", () => {
    expect(JSON.stringify(readServerAddress("https://me:hunter2@example.com/mcp"))).not.toContain(
      "hunter2",
    );
  });
});
