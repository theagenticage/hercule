/** Tests `hasReachedRotationThreshold`, the rule that decides when a session's context is full enough to rotate. */
import { describe, expect, it } from "vitest";
import type { Rotation } from "@hercule/contract";
import { hasReachedRotationThreshold } from "./delivery";

const rotation: Rotation = { contextFraction: 0.5, maxContextTokens: 1_000, dailyAt: "04:00" };

describe("hasReachedRotationThreshold", () => {
  it("is full at the fraction of the window when that is below the maximum", () => {
    expect(
      hasReachedRotationThreshold(
        { ...rotation, maxContextTokens: 10_000 },
        { tokens: 500, windowTokens: 1_000 },
      ),
    ).toBe(true);
    expect(
      hasReachedRotationThreshold(
        { ...rotation, maxContextTokens: 10_000 },
        { tokens: 499, windowTokens: 1_000 },
      ),
    ).toBe(false);
  });

  it("is full at the maximum when that is below the fraction of the window", () => {
    expect(hasReachedRotationThreshold(rotation, { tokens: 1_000, windowTokens: 100_000 })).toBe(true);
    expect(hasReachedRotationThreshold(rotation, { tokens: 999, windowTokens: 100_000 })).toBe(false);
  });

  it("applies only the maximum when there is no window", () => {
    expect(hasReachedRotationThreshold(rotation, { tokens: 999 })).toBe(false);
    expect(hasReachedRotationThreshold(rotation, { tokens: 1_000 })).toBe(true);
  });

  it("counts exact equality as full", () => {
    expect(
      hasReachedRotationThreshold({ ...rotation, contextFraction: 1 }, { tokens: 800, windowTokens: 800 }),
    ).toBe(true);
  });
});
