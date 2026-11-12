import { describe, expect, it } from "vitest";
import { compareCounts } from "./perf-counts-ratchet.ts";

describe("compareCounts", () => {
  it.each([
    ["one more request", "screens/inbox/J x50/requests", 49, 50],
    ["one more render", "screens/work/open/renders", 335, 336],
    ["one more reply byte", "controller/board/board, 10 Tasks/bytes", 5118, 5119],
    ["a restyle count past 10 %", "screens/inbox/J x50/restyled", 15_800, 17_400],
    ["a small restyle count past 25 elements", "screens/inbox/open a card/restyled", 60, 86],
  ])("fails on %s", (_name, key, baseline, current) => {
    const comparison = compareCounts({ [key]: current }, { [key]: baseline });

    expect(comparison.worse).toEqual([{ key, baseline, current }]);
    expect(comparison.passed).toBe(false);
  });

  it("passes a restyle count within its tolerance, and reports a count that fell as better", () => {
    const comparison = compareCounts(
      { "screens/inbox/J x50/restyled": 17_300, "screens/inbox/J x50/requests": 48 },
      { "screens/inbox/J x50/restyled": 15_800, "screens/inbox/J x50/requests": 49 },
    );

    expect(comparison.worse).toEqual([]);
    expect(comparison.better).toEqual([
      { key: "screens/inbox/J x50/requests", baseline: 49, current: 48 },
    ]);
    expect(comparison.passed).toBe(true);
  });

  it("fails when a key is missing on either side", () => {
    const comparison = compareCounts(
      { "screens/work/open/requests": 51 },
      { "screens/inbox/open/requests": 50 },
    );

    expect(comparison.missingFromRun).toEqual(["screens/inbox/open/requests"]);
    expect(comparison.missingFromBaseline).toEqual(["screens/work/open/requests"]);
    expect(comparison.passed).toBe(false);
  });
});
