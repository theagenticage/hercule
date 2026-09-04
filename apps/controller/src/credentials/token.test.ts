import { describe, expect, it } from "vitest";
import { hashToken, mintToken } from "./token";

describe("token hashing", () => {
  it("mints an opaque url-safe token and stores only its digest", () => {
    const token = mintToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toBe(hashToken(mintToken()));
  });
});
