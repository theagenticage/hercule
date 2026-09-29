/**
 * Tests `formatAge(at, now)`, which formats the time since `at` in the largest
 * unit that fits, `describeAge(at, now)`, which says the same age in words,
 * and `findNextAgeChange(at, now)`, which finds the moment both next change.
 */
import { describe, expect, it } from "vitest";
import { describeAge, findNextAgeChange, formatAge } from "./age";

const NOW = new Date("2026-09-08T12:00:00.000Z");

describe("formatAge", () => {
  it("shows under a minute as now", () => {
    expect(formatAge("2026-09-08T11:59:31.000Z", NOW)).toBe("now");
    expect(formatAge(NOW.toISOString(), NOW)).toBe("now");
  });

  it("shows minutes under an hour", () => {
    expect(formatAge("2026-09-08T11:55:00.000Z", NOW)).toBe("5m");
    expect(formatAge("2026-09-08T11:01:00.000Z", NOW)).toBe("59m");
  });

  it("shows hours under a day", () => {
    expect(formatAge("2026-09-08T09:00:00.000Z", NOW)).toBe("3h");
    expect(formatAge("2026-09-07T13:00:00.000Z", NOW)).toBe("23h");
  });

  it("shows days under a week", () => {
    expect(formatAge("2026-09-06T12:00:00.000Z", NOW)).toBe("2d");
    expect(formatAge("2026-09-02T00:00:00.000Z", NOW)).toBe("6d");
  });

  it("shows weeks from seven days on", () => {
    expect(formatAge("2026-08-18T12:00:00.000Z", NOW)).toBe("3w");
    expect(formatAge("2026-09-01T12:00:00.000Z", NOW)).toBe("1w");
  });

  it("never shows seconds", () => {
    expect(formatAge("2026-09-08T11:55:59.000Z", NOW)).toBe("4m");
  });

  it("never shows a negative age for an instant after now", () => {
    expect(formatAge("2026-09-08T12:05:00.000Z", NOW)).toBe("now");
  });
});

describe("describeAge", () => {
  it("says under a minute as just now", () => {
    expect(describeAge("2026-09-08T11:59:31.000Z", NOW)).toBe("just now");
    expect(describeAge("2026-09-08T12:05:00.000Z", NOW)).toBe("just now");
  });

  it("says one unit in the singular and more in the plural", () => {
    expect(describeAge("2026-09-08T11:59:00.000Z", NOW)).toBe("1 minute ago");
    expect(describeAge("2026-09-08T11:40:00.000Z", NOW)).toBe("20 minutes ago");
    expect(describeAge("2026-09-08T11:00:00.000Z", NOW)).toBe("1 hour ago");
    expect(describeAge("2026-09-08T09:00:00.000Z", NOW)).toBe("3 hours ago");
    expect(describeAge("2026-09-07T12:00:00.000Z", NOW)).toBe("1 day ago");
    expect(describeAge("2026-09-02T00:00:00.000Z", NOW)).toBe("6 days ago");
    expect(describeAge("2026-09-01T12:00:00.000Z", NOW)).toBe("1 week ago");
    expect(describeAge("2026-08-18T12:00:00.000Z", NOW)).toBe("3 weeks ago");
  });

  it("counts the same age formatAge shows", () => {
    expect(formatAge("2026-09-08T11:55:59.000Z", NOW)).toBe("4m");
    expect(describeAge("2026-09-08T11:55:59.000Z", NOW)).toBe("4 minutes ago");
  });
});

describe("findNextAgeChange", () => {
  const AT = "2026-09-08T12:00:00.000Z";
  const START = Date.parse(AT);
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;

  /** Returns the moment `offset` milliseconds after `AT`. */
  const buildMoment = (offset: number): Date => new Date(START + offset);

  /** Returns the next change, as milliseconds after `AT`, seen from `offset` after it. */
  const findChangeOffset = (offset: number): number =>
    findNextAgeChange(AT, buildMoment(offset)).getTime() - START;

  it("finds each boundary formatAge has, from just before it and from on it", () => {
    const boundaries: readonly [number, string, string][] = [
      [MINUTE, "now", "1m"],
      [2 * MINUTE, "1m", "2m"],
      [HOUR, "59m", "1h"],
      [2 * HOUR, "1h", "2h"],
      [DAY, "23h", "1d"],
      [2 * DAY, "1d", "2d"],
      [WEEK, "6d", "1w"],
      [2 * WEEK, "1w", "2w"],
    ];
    for (const [boundary, before, after] of boundaries) {
      expect(formatAge(AT, buildMoment(boundary - 1))).toBe(before);
      expect(formatAge(AT, buildMoment(boundary))).toBe(after);
      expect(findChangeOffset(boundary - 1)).toBe(boundary);
      // Exactly on a boundary the text has just changed, so the next change is
      // one unit later, not now.
      expect(findChangeOffset(boundary)).toBeGreaterThan(boundary);
    }
  });

  it("finds the next unit's change from the start of each unit", () => {
    expect(findChangeOffset(0)).toBe(MINUTE);
    expect(findChangeOffset(MINUTE)).toBe(2 * MINUTE);
    expect(findChangeOffset(HOUR)).toBe(2 * HOUR);
    expect(findChangeOffset(DAY)).toBe(2 * DAY);
    expect(findChangeOffset(WEEK)).toBe(2 * WEEK);
  });

  it("finds the first minute's end for an instant after now, which formatAge shows as now", () => {
    expect(formatAge(AT, buildMoment(-5 * MINUTE))).toBe("now");
    expect(findChangeOffset(-5 * MINUTE)).toBe(MINUTE);
  });

  // The function reports the true moment. Clamping it to what setTimeout can
  // wait is the caller's job.
  it("returns the true moment for an instant far after now, even past what setTimeout can wait", () => {
    const farAhead = 30 * DAY;

    expect(findChangeOffset(-farAhead)).toBe(MINUTE);
    expect(findChangeOffset(-farAhead) + farAhead).toBeGreaterThan(2_147_483_647);
  });

  it("always returns a later moment where both texts differ, and one millisecond earlier neither has changed", () => {
    // A deterministic walk over ten weeks with an irregular step, so the
    // offsets land on, just before and between boundaries of every unit.
    const offsets = [-1, 0, 1, MINUTE - 1, MINUTE, HOUR - 1, HOUR, DAY - 1, DAY, WEEK - 1, WEEK];
    for (let offset = 0; offset < 10 * WEEK; offset += 7_777_777) offsets.push(offset);
    for (let offset = 0; offset < 2 * HOUR; offset += 77_777) offsets.push(offset);

    for (const offset of offsets) {
      const now = buildMoment(offset);
      const next = findNextAgeChange(AT, now);
      const justBefore = new Date(next.getTime() - 1);
      const label = `at ${String(offset)}`;
      expect(next.getTime(), label).toBeGreaterThan(now.getTime());
      for (const format of [formatAge, describeAge]) {
        const shown = format(AT, now);
        expect(format(AT, next), label).not.toBe(shown);
        expect(format(AT, justBefore), label).toBe(shown);
      }
    }
  });
});
