import { describe, expect, it } from "vitest";
import { formatDuration } from "./duration";

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
