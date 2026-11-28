import { describe, expect, it } from "vitest";
import { buildPastedRedirectUri } from "./mcp-server-sign-in";

describe("buildPastedRedirectUri", () => {
  it("is a loopback callback address on a port from 49152 to 65535", () => {
    const uris = Array.from({ length: 500 }, buildPastedRedirectUri);
    for (const uri of uris) {
      expect(uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      const port = Number(new URL(uri).port);
      expect(port).toBeGreaterThanOrEqual(49152);
      expect(port).toBeLessThanOrEqual(65535);
    }
    // Each call picks its own port, so one sign-in's address is not the next's.
    expect(new Set(uris).size).toBeGreaterThan(1);
  });
});
