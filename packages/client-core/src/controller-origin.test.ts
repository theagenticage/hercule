import { describe, expect, it } from "vitest";
import { formatControllerAddress, isLoopbackOrigin } from "./controller-origin";

describe("formatControllerAddress", () => {
  it("drops the scheme", () => {
    expect(formatControllerAddress("http://127.0.0.1:4937")).toBe("127.0.0.1:4937");
  });

  it("returns what does not parse unchanged", () => {
    expect(formatControllerAddress("not an origin")).toBe("not an origin");
  });
});

describe("isLoopbackOrigin", () => {
  it("accepts an origin on this machine", () => {
    for (const origin of [
      "http://127.0.0.1:4937",
      // The whole 127.0.0.0/8 block is loopback, not only 127.0.0.1.
      "http://127.0.0.2:4937",
      "http://127.1:4937",
      "http://localhost:4937",
      "http://[::1]:4937",
    ]) {
      expect(isLoopbackOrigin(origin)).toBe(true);
    }
  });

  it("refuses an origin on another machine, and one that does not parse", () => {
    for (const origin of [
      "http://10.0.0.2:4937",
      "http://128.0.0.1:4937",
      "https://127.0.0.1.example",
      "https://hercule.example",
      "not a url",
    ]) {
      expect(isLoopbackOrigin(origin)).toBe(false);
    }
  });
});
