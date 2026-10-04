import { describe, expect, it } from "vitest";
import { isHttpUrl } from "./http-url";

describe("isHttpUrl", () => {
  it.each([
    "http://127.0.0.1:4100",
    "https://hercule.example.com/docs?page=1#top",
    "HTTPS://EXAMPLE.COM",
  ])("accepts %s", (url) => expect(isHttpUrl(url)).toBe(true));

  it.each([
    "",
    "example.com",
    "/relative/path",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "mailto:someone@example.com",
    "app://hercule/",
    "ftp://example.com",
    "ws://127.0.0.1:4100",
  ])("refuses %j", (url) => expect(isHttpUrl(url)).toBe(false));
});
