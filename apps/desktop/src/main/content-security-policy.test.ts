import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy } from "./content-security-policy";

describe("buildContentSecurityPolicy", () => {
  it("lets the packaged app connect nowhere before a controller is saved", () => {
    // Spec 17's policy, word for word, with connect-src 'none'.
    expect(buildContentSecurityPolicy(null, null)).toBe(
      "default-src 'self'; script-src 'self'; connect-src 'none'; img-src 'self' data: blob:; " +
        "font-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; " +
        "base-uri 'self'; form-action 'none'",
    );
  });

  it("lets the packaged app connect to the saved controller over HTTP and WebSocket only", () => {
    expect(buildContentSecurityPolicy("http://127.0.0.1:4937", null)).toBe(
      "default-src 'self'; script-src 'self'; " +
        "connect-src http://127.0.0.1:4937 ws://127.0.0.1:4937; img-src 'self' data: blob:; " +
        "font-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; " +
        "base-uri 'self'; form-action 'none'",
    );
  });

  it("pairs an https controller with wss, and names only its origin", () => {
    expect(buildContentSecurityPolicy("https://hercule.example/some/path?x=1", null)).toContain(
      "; connect-src https://hercule.example wss://hercule.example; ",
    );
  });

  it("keeps a controller's non-default port and drops its default one", () => {
    expect(buildContentSecurityPolicy("https://hercule.example:8443/", null)).toContain(
      "connect-src https://hercule.example:8443 wss://hercule.example:8443;",
    );
    expect(buildContentSecurityPolicy("http://hercule.example:80/", null)).toContain(
      "connect-src http://hercule.example ws://hercule.example;",
    );
  });

  it("adds the dev server and inline scripts and styles in development", () => {
    expect(buildContentSecurityPolicy("http://127.0.0.1:4937", "http://127.0.0.1:5199/")).toBe(
      "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
        "connect-src http://127.0.0.1:4937 ws://127.0.0.1:4937 http://127.0.0.1:5199 ws://127.0.0.1:5199; " +
        "img-src 'self' data: blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'",
    );
  });

  it("lets development connect to the dev server alone before a controller is saved", () => {
    expect(buildContentSecurityPolicy(null, "http://127.0.0.1:5199/")).toContain(
      "; connect-src http://127.0.0.1:5199 ws://127.0.0.1:5199; ",
    );
  });
});
