import { describe, expect, it } from "vitest";
import { APP_SCHEME, isOnRendererOrigin, RENDERER_URL } from "./renderer-origin";

describe("APP_SCHEME and RENDERER_URL", () => {
  it("serve the renderer at app://hercule/", () => {
    expect(APP_SCHEME).toBe("app");
    expect(RENDERER_URL).toBe("app://hercule/");
  });
});

describe("isOnRendererOrigin", () => {
  it.each(["app://hercule", "app://hercule/", "app://hercule/assets/index.js?x=1#y"])(
    "accepts %j",
    (url) => expect(isOnRendererOrigin(url)).toBe(true),
  );

  it.each([
    "app://other/",
    "app://hercule.example.com/",
    "app://hercule:8080/",
    "http://hercule/",
    "https://hercule.example.com/",
    "file:///Applications/Hercule.app",
    "null",
    "",
  ])("refuses %j", (url) => expect(isOnRendererOrigin(url)).toBe(false));
});
