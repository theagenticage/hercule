import { describe, expect, it } from "vitest";
import { buildControllerOrigin, isWildcardHost } from "./origin";

const WILDCARD_SPELLINGS = ["0.0.0.0", "::", "[::]", "0:0:0:0:0:0:0:0"];

describe("isWildcardHost", () => {
  it.each(WILDCARD_SPELLINGS)("recognises %s", (host) => {
    expect(isWildcardHost(host)).toBe(true);
  });

  it.each(["127.0.0.1", "::1", "[::1]", "localhost", "hercule.local", "100.64.0.1", "fd00::1"])(
    "does not take %s for a wildcard",
    (host) => {
      expect(isWildcardHost(host)).toBe(false);
    },
  );

  it("returns false for a value that is not a host", () => {
    expect(isWildcardHost("http://[")).toBe(false);
  });
});

describe("buildControllerOrigin", () => {
  it.each(WILDCARD_SPELLINGS)("turns the wildcard %s into loopback", (host) => {
    expect(buildControllerOrigin(host, 8080)).toBe("http://127.0.0.1:8080");
  });

  it("puts an IPv6 literal in brackets, once", () => {
    expect(buildControllerOrigin("fd00::1", 4937)).toBe("http://[fd00::1]:4937");
    expect(buildControllerOrigin("[fd00::1]", 4937)).toBe("http://[fd00::1]:4937");
  });

  it("keeps any other host as it is", () => {
    expect(buildControllerOrigin("127.0.0.1", 4937)).toBe("http://127.0.0.1:4937");
    expect(buildControllerOrigin("hercule.local", 4937)).toBe("http://hercule.local:4937");
  });
});
