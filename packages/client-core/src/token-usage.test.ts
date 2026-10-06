import { describe, expect, it } from "vitest";
import { countUsedTokens, describeTokenUsage } from "./token-usage";

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

describe("describeTokenUsage", () => {
  it("labels a known subtotal as incomplete and leaves an exact count numeric", () => {
    const counts = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 };
    expect(describeTokenUsage({ status: "incomplete", counts })).toBe("125 (incomplete)");
    expect(describeTokenUsage({ status: "complete", counts })).toBe(125);
  });
});
