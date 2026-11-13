/** Tests the wait that a row and the pane write: its text, its words and its level. */
import { describe, expect, it } from "vitest";
import { describeWaitSince } from "./card-wait";

const NOW = new Date("2026-11-07T12:00:00.000Z");
const hoursAgo = (hours: number): string =>
  new Date(NOW.getTime() - hours * 3_600_000).toISOString();

describe("describeWaitSince", () => {
  it.each([
    [0.0001, "now", "Waiting less than a minute"],
    [0.2, "12m", "Waiting 12 minutes"],
    [5.9, "5h", "Waiting 5 hours"],
    [23.9, "23h", "Waiting 23 hours"],
    [24, "1d", "Waiting 1 day"],
    [50, "2d", "Waiting 2 days"],
    [14 * 24, "2w", "Waiting 2 weeks"],
    [4 * 30 * 24, "4mo", "Waiting 4 months"],
  ])("writes a wait of %s hours as %s", (hours, text, words) => {
    expect(describeWaitSince(hoursAgo(hours), 10_000, NOW)).toMatchObject({ text, words });
  });

  it.each([
    [11, "fresh"],
    [11.9, "fresh"],
    [12, "recent"],
    [23, "recent"],
    [24, "due"],
    [71, "due"],
    [72, "over"],
    [500, "over"],
  ])("puts a wait of %s hours on a 24-hour patience at %s", (hours, level) => {
    expect(describeWaitSince(hoursAgo(hours), 24, NOW).level).toBe(level);
  });

  it("measures the same hours against the patience of the kind", () => {
    const wait = (patience: number) => describeWaitSince(hoursAgo(12), patience, NOW).level;
    expect(wait(12)).toBe("due");
    expect(wait(336)).toBe("fresh");
  });

  it("treats a patience of zero as one hour, so the level is still defined", () => {
    expect(describeWaitSince(hoursAgo(4), 0, NOW).level).toBe("over");
  });

  it("reads a wait that starts in the future as no time yet", () => {
    expect(describeWaitSince(hoursAgo(-3), 24, NOW)).toMatchObject({ text: "now", level: "fresh" });
  });
});
