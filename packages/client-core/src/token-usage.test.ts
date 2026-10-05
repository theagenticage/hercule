import { describe, expect, it } from "vitest";
import { countUsedTokens } from "./token-usage";

describe("countUsedTokens", () => {
  it("adds up the four parts", () => {
    expect(
      countUsedTokens({
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 3000,
        cacheWriteTokens: 400,
      }),
    ).toBe(3520);
  });

  it("counts a part the harness does not report as none", () => {
    expect(countUsedTokens({ inputTokens: 100, outputTokens: 20 })).toBe(120);
  });
});
