import { describe, expect, it } from "vitest";
import { isDiskBelowLimit } from "./disk-limit";

describe("whether free disk is below the disk limit", () => {
  it.each([
    { name: "one byte under the limit", free: 99, below: true },
    { name: "exactly at the limit", free: 100, below: false },
    { name: "one byte over the limit", free: 101, below: false },
    { name: "no free disk at all", free: 0, below: true },
  ])("is $below for $name", ({ free, below }) => {
    expect(isDiskBelowLimit({ diskFreeBytes: free }, 100)).toBe(below);
  });

  it("is false for a runner that has not reported metrics yet", () => {
    expect(isDiskBelowLimit(null, 100)).toBe(false);
  });
});
