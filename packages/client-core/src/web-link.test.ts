import { describe, expect, it } from "vitest";
import { isWebLink } from "./web-link";

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
