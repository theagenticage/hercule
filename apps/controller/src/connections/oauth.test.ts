/**
 * Tests which redirect URIs a public client's registration covers. A provider
 * accepts only what it registered, so a wrong answer here either sends the
 * user to a provider that refuses, or refuses an address the provider accepts.
 */
import { describe, expect, it } from "vitest";
import { isRegisteredRedirectUri } from "./oauth";

describe("isRegisteredRedirectUri", () => {
  it("matches an http loopback URI registered without a port at any port, as Slack's client is", () => {
    expect(
      isRegisteredRedirectUri("http://127.0.0.1/callback", "http://127.0.0.1:53682/callback"),
    ).toBe(true);
    expect(
      isRegisteredRedirectUri(
        "http://localhost/oauth/callback",
        "http://localhost:4937/oauth/callback",
      ),
    ).toBe(true);
  });

  it("matches a URI registered with a port only at that port, as Linear's client is", () => {
    const registered = "http://127.0.0.1:4937/oauth/callback";

    expect(isRegisteredRedirectUri(registered, registered)).toBe(true);
    expect(isRegisteredRedirectUri(registered, "http://127.0.0.1:4938/oauth/callback")).toBe(false);
    expect(isRegisteredRedirectUri(registered, "http://127.0.0.1/oauth/callback")).toBe(false);
  });

  it("keeps the host and the path exact when it lets the port vary", () => {
    const registered = "http://127.0.0.1/callback";

    expect(isRegisteredRedirectUri(registered, "http://localhost:53682/callback")).toBe(false);
    expect(isRegisteredRedirectUri(registered, "http://127.0.0.1:53682/oauth/callback")).toBe(
      false,
    );
    expect(isRegisteredRedirectUri(registered, "http://127.0.0.1:53682/callback/extra")).toBe(
      false,
    );
  });

  it("lets the port vary only for http, and never admits a query, a fragment or user information", () => {
    expect(
      isRegisteredRedirectUri("https://127.0.0.1/callback", "https://127.0.0.1:53682/callback"),
    ).toBe(false);
    for (const redirectUri of [
      "http://127.0.0.1:53682/callback?next=1",
      "http://127.0.0.1:53682/callback#top",
      "http://user:pass@127.0.0.1:53682/callback",
    ]) {
      expect(isRegisteredRedirectUri("http://127.0.0.1/callback", redirectUri)).toBe(false);
    }
  });

  it("treats a URI registered with the default port as registered with a port", () => {
    expect(
      isRegisteredRedirectUri("http://127.0.0.1:80/callback", "http://127.0.0.1:8080/callback"),
    ).toBe(false);
  });
});
