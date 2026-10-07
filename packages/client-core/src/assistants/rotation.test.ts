/**
 * Tests the rotation section's choices and words: the shares of the context
 * and the token limits the selects offer, and how each is written.
 */
import { describe, expect, it } from "vitest";
import {
  formatContextFraction,
  formatTokenLimit,
  listContextFractionChoices,
  listContextTokenChoices,
} from "./rotation";

describe("listContextFractionChoices", () => {
  it("offers the standard shares when the stored one is among them", () => {
    expect(listContextFractionChoices(0.7)).toEqual([0.5, 0.6, 0.7, 0.8, 0.9]);
  });

  it("adds a stored share set outside the app, in order", () => {
    expect(listContextFractionChoices(0.75)).toEqual([0.5, 0.6, 0.7, 0.75, 0.8, 0.9]);
    expect(listContextFractionChoices(1)).toEqual([0.5, 0.6, 0.7, 0.8, 0.9, 1]);
  });
});

describe("listContextTokenChoices", () => {
  it("offers the standard limits when the stored one is among them", () => {
    expect(listContextTokenChoices(200_000)).toEqual([100_000, 200_000, 400_000, 1_000_000]);
  });

  it("adds a stored limit set outside the app, in order", () => {
    expect(listContextTokenChoices(150_000)).toEqual([
      100_000, 150_000, 200_000, 400_000, 1_000_000,
    ]);
    expect(listContextTokenChoices(50_000)).toEqual([50_000, 100_000, 200_000, 400_000, 1_000_000]);
  });
});

describe("formatContextFraction", () => {
  it.each([
    [0.7, "70%"],
    [0.5, "50%"],
    [1, "100%"],
    [0.725, "72.5%"],
    [0.333333, "33.3%"],
  ])("writes %d as %s", (fraction, text) => {
    expect(formatContextFraction(fraction)).toBe(text);
  });
});

describe("formatTokenLimit", () => {
  it.each([
    [950, "950"],
    [1500, "1.5k"],
    [100_000, "100k"],
    [150_000, "150k"],
    [200_000, "200k"],
    [999_999, "1M"],
    [1_000_000, "1M"],
    [1_500_000, "1.5M"],
  ])("writes %d as %s", (tokens, text) => {
    expect(formatTokenLimit(tokens)).toBe(text);
  });
});
