import { describe, expect, it } from "vitest";
import { buildControllerOrigin, isLoopbackHost, isWildcardHost } from "./origin";

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

describe("isLoopbackHost", () => {
  it.each(["127.0.0.1", "127.1", "127.0.0.255", "localhost", "LocalHost", "::1", "[::1]"])(
    "recognises %s",
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each(["0.0.0.0", "::", "hercule.local", "100.64.0.1", "192.168.1.1"])(
    "does not take %s for loopback",
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );

  it("returns false for a value that is not a host", () => {
    expect(isLoopbackHost("http://[")).toBe(false);
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

  it("returns the origin the way a browser writes it", () => {
    expect(buildControllerOrigin("127.1", 4937)).toBe("http://127.0.0.1:4937");
    expect(buildControllerOrigin("LocalHost", 4937)).toBe("http://localhost:4937");
    expect(buildControllerOrigin("::1", 4937)).toBe("http://[::1]:4937");
    expect(buildControllerOrigin("0:0:0:0:0:0:0:1", 4937)).toBe("http://[::1]:4937");
  });

  it("leaves out port 80, the default port for http", () => {
    expect(buildControllerOrigin("127.0.0.1", 80)).toBe("http://127.0.0.1");
    expect(buildControllerOrigin("0.0.0.0", 80)).toBe("http://127.0.0.1");
  });

  it("returns a value that is its own origin", () => {
    for (const host of ["127.1", "LocalHost", "0:0:0:0:0:0:0:1", "::", "hercule.local"]) {
      const origin = buildControllerOrigin(host, 4937);
      expect(new URL(origin).origin).toBe(origin);
    }
  });
});
