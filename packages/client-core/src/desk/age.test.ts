/**
 * Tests the age a card shows: its words at each age, and that the moment
 * `findNextDeskAgeChange` returns is the first one at which the words change.
 */
import { describe, expect, it } from "vitest";
import { describeDeskAge, findNextDeskAgeChange, formatDeskAge } from "./age";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-07T09:00:00.000Z");

/** Returns the moment `days` days (and `extraMs` more) before `NOW`. */
const before = (days: number, extraMs = 0): string =>
  new Date(NOW.getTime() - days * DAY_MS - extraMs).toISOString();

describe("formatDeskAge and describeDeskAge", () => {
  it.each([
    { days: 0, short: "today", long: "today" },
    { days: 1, short: "1d", long: "1 day ago" },
    { days: 2, short: "2d", long: "2 days ago" },
    { days: 13, short: "13d", long: "13 days ago" },
    { days: 14, short: "2w", long: "2 weeks ago" },
    { days: 17, short: "2w", long: "2 weeks ago" },
    { days: 18, short: "3w", long: "3 weeks ago" },
    { days: 28, short: "4w", long: "4 weeks ago" },
    { days: 70, short: "10w", long: "10 weeks ago" },
  ])("reads $days days as $short", ({ days, short, long }) => {
    expect(formatDeskAge(before(days), NOW)).toBe(short);
    expect(describeDeskAge(before(days), NOW)).toBe(long);
  });

  it("counts whole days only, so 23 hours is still today", () => {
    expect(formatDeskAge(before(0, 23 * 60 * 60 * 1000), NOW)).toBe("today");
  });

  it("counts a moment after now as no time at all", () => {
    expect(formatDeskAge(before(-3), NOW)).toBe("today");
    expect(describeDeskAge(before(-3), NOW)).toBe("today");
  });
});

describe("findNextDeskAgeChange", () => {
  it.each([0, 1, 5, 12, 13, 14, 17, 18, 24, 25, 100])(
    "from %i days old, finds the first moment the words change",
    (days) => {
      const at = before(days, 3_600_000);
      const next = findNextDeskAgeChange(at, NOW);
      expect(next.getTime()).toBeGreaterThan(NOW.getTime());
      const justBefore = new Date(next.getTime() - 1);
      expect(formatDeskAge(at, justBefore)).toBe(formatDeskAge(at, NOW));
      expect(formatDeskAge(at, next)).not.toBe(formatDeskAge(at, NOW));
      expect(describeDeskAge(at, next)).not.toBe(describeDeskAge(at, NOW));
    },
  );

  it("waits a day after an at in the future", () => {
    const at = before(-3);
    expect(findNextDeskAgeChange(at, NOW).getTime()).toBe(Date.parse(at) + DAY_MS);
  });
});
