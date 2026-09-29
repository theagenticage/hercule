import { describe, expect, it } from "vitest";
import { isOnRendererOrigin } from "./renderer-origin";

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
