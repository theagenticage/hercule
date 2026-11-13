import { describe, expect, it } from "vitest";
import { compareCounts } from "./perf-counts-report.ts";

describe("compareCounts", () => {
  it.each([
    ["one more request", "screens/inbox/J x50/requests", 49, 50],
    ["one more element", "screens/work/open/elements", 674, 675],
    ["one more reply byte", "controller/board/board, 10 Tasks/bytes", 5118, 5119],
    ["renders past 5 %", "screens/inbox/J x50/renders", 1_880, 1_975],
    ["row renders past 5 renders", "screens/inbox/E/rowRenders", 33, 39],
    ["a restyle count past 10 %", "screens/inbox/J x50/restyled", 15_800, 17_400],
    ["a small restyle count past 25 elements", "screens/inbox/open a card/restyled", 60, 86],
  ])("lists %s as higher", (_name, key, baseline, current) => {
    expect(compareCounts({ [key]: current }, { [key]: baseline }).higher).toEqual([
      { key, baseline, current },
    ]);
  });

  it("leaves restyles and renders within their noise unlisted, and lists a count that fell as lower", () => {
    const comparison = compareCounts(
      {
        "screens/inbox/J x50/restyled": 17_300,
        "screens/inbox/J x50/renders": 1_881,
        "screens/inbox/J x50/requests": 48,
      },
      {
        "screens/inbox/J x50/restyled": 15_800,
        "screens/inbox/J x50/renders": 1_880,
        "screens/inbox/J x50/requests": 49,
      },
    );

    expect(comparison.higher).toEqual([]);
    expect(comparison.lower).toEqual([
      { key: "screens/inbox/J x50/requests", baseline: 49, current: 48 },
    ]);
  });

  it("lists the keys on one side only as new or gone", () => {
    const comparison = compareCounts(
      { "screens/work/open/requests": 51 },
      { "screens/inbox/open/requests": 50 },
    );

    expect(comparison.added).toEqual(["screens/work/open/requests"]);
    expect(comparison.gone).toEqual(["screens/inbox/open/requests"]);
  });
});
