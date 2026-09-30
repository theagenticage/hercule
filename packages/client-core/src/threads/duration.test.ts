import { describe, expect, it } from "vitest";
import { findNextDurationChange, formatDuration } from "./duration";

describe("formatDuration", () => {
  it("shows under a minute as seconds", () => {
    expect(formatDuration(31_000)).toBe("31s");
    expect(formatDuration(0)).toBe("0s");
  });

  it("shows a minute or more as minutes and seconds", () => {
    expect(formatDuration(12 * 60_000 + 4_000)).toBe("12m 4s");
    expect(formatDuration(60_000)).toBe("1m 0s");
  });

  it("drops seconds from an hour on", () => {
    expect(formatDuration(60 * 60_000 + 4 * 60_000 + 9_000)).toBe("1h 4m");
  });
});

describe("findNextDurationChange", () => {
  const SINCE = "2026-09-30T09:00:00.000Z";
  const start = Date.parse(SINCE);
  const at = (elapsed: number): Date => new Date(start + elapsed);
  const findElapsed = (elapsed: number): number =>
    findNextDurationChange(SINCE, at(elapsed)).getTime() - start;

  it("returns the next half second under an hour, where the rounded seconds change", () => {
    expect(findElapsed(0)).toBe(500);
    expect(findElapsed(1_499)).toBe(1_500);
    expect(findElapsed(1_500)).toBe(2_500);
    expect(findElapsed(12 * 60_000 + 4_000)).toBe(12 * 60_000 + 4_500);
  });

  it("returns the moment the hour starts from the last second before it", () => {
    expect(findElapsed(3_599_000)).toBe(3_599_500);
    expect(formatDuration(3_599_499)).toBe("59m 59s");
    expect(formatDuration(3_599_500)).toBe("1h 0m");
  });

  it("returns the next whole minute from an hour on, where only minutes are shown", () => {
    expect(findElapsed(3_599_500)).toBe(3_659_500);
    expect(findElapsed(3_600_000 + 4 * 60_000 + 9_000)).toBe(3_600_000 + 5 * 60_000 - 500);
  });

  it("returns half a second after a since that is later than now", () => {
    expect(findElapsed(-10_000)).toBe(500);
  });

  it("always returns a moment at which the text differs from now's", () => {
    for (const elapsed of [0, 499, 500, 59_499, 59_500, 3_599_499, 3_659_499, 7_200_000]) {
      const next = findElapsed(elapsed);
      expect(next).toBeGreaterThan(elapsed);
      expect(formatDuration(next)).not.toBe(formatDuration(elapsed));
      expect(formatDuration(next - 1)).toBe(formatDuration(elapsed));
    }
  });
});
