import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { hashPassword, TEST_PASSWORD_PARAMS, verifyPassword } from "./password";

describe("passwords", () => {
  it("round trips a password through an argon2id PHC string", async () => {
    const hash = await Effect.runPromise(hashPassword("correct horse", TEST_PASSWORD_PARAMS));
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(hash).not.toContain("correct horse");
    expect(await Effect.runPromise(verifyPassword("correct horse", hash))).toBe(true);
    expect(await Effect.runPromise(verifyPassword("battery staple", hash))).toBe(false);
  });

  it("salts, so the same password hashes differently every time", async () => {
    const first = await Effect.runPromise(hashPassword("same", TEST_PASSWORD_PARAMS));
    const second = await Effect.runPromise(hashPassword("same", TEST_PASSWORD_PARAMS));
    expect(first).not.toBe(second);
  });

  it("verifies a hash written under different parameters", async () => {
    const hash = await Effect.runPromise(
      hashPassword("portable", { memoryCost: 8192, timeCost: 3 }),
    );
    expect(hash).toContain("m=8192,t=3");
    expect(await Effect.runPromise(verifyPassword("portable", hash))).toBe(true);
  });

  it("answers false for a stored value that is not a hash at all", async () => {
    expect(await Effect.runPromise(verifyPassword("anything", "not-a-phc-string"))).toBe(false);
  });
});
