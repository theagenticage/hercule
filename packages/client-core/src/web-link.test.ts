import { describe, expect, it } from "vitest";
import { formatUrlWithoutScheme, isWebLink } from "./web-link";

describe("isWebLink", () => {
  it("accepts http and https addresses", () => {
    expect(isWebLink("https://github.com/acme/app/issues/7")).toBe(true);
    expect(isWebLink("http://localhost:3000/")).toBe(true);
    expect(isWebLink("HTTPS://GITHUB.COM/")).toBe(true);
  });

  it("refuses any other scheme", () => {
    expect(isWebLink("data:text/html,<h1>Sign in</h1>")).toBe(false);
    expect(isWebLink("javascript:alert(1)")).toBe(false);
    expect(isWebLink("file:///etc/passwd")).toBe(false);
    expect(isWebLink("ftp://example.com/")).toBe(false);
  });

  it("refuses text that is not an absolute URL", () => {
    expect(isWebLink("/runs/1")).toBe(false);
    expect(isWebLink("github.com/acme/app")).toBe(false);
    expect(isWebLink("")).toBe(false);
  });
});

describe("formatUrlWithoutScheme", () => {
  it("keeps the host and the path, dropping the scheme, the query and the fragment", () => {
    expect(formatUrlWithoutScheme("https://github.com/login/device?x=1#top")).toBe(
      "github.com/login/device",
    );
  });

  it("drops a path that is only a slash", () => {
    expect(formatUrlWithoutScheme("https://sentry.io/")).toBe("sentry.io");
  });

  it("returns text that does not parse unchanged", () => {
    expect(formatUrlWithoutScheme("enter the code at github")).toBe("enter the code at github");
  });
});
