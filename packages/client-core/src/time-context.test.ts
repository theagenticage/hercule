import { assert, describe, it } from "vitest";
import {
  computeMinutesOfDay,
  chooseStamps,
  formatDay,
  formatDayStamp,
  formatPreciseStamp,
  formatSince,
  formatStamp,
  formatTimeContext,
  isSameDay,
} from "./time-context";

/** Monday 2026-09-07, 07:14 UTC. */
const MONDAY_MORNING = new Date("2026-09-07T07:14:00Z");

describe("formatTimeContext", () => {
  it("formats the weekday and 24-hour time in the given zone", () => {
    assert.strictEqual(formatTimeContext(MONDAY_MORNING, "Europe/Amsterdam"), "Monday 09:14");
    assert.strictEqual(formatTimeContext(MONDAY_MORNING, "UTC"), "Monday 07:14");
  });

  it("takes the weekday from the zone, not from UTC", () => {
    // 23:40 Sunday in New York is already Monday in UTC.
    const instant = new Date("2026-09-07T03:40:00Z");
    assert.strictEqual(formatTimeContext(instant, "America/New_York"), "Sunday 23:40");
    assert.strictEqual(formatTimeContext(instant, "UTC"), "Monday 03:40");
  });

  it("pads the hour and keeps midnight at 00", () => {
    const instant = new Date("2026-09-05T22:05:00Z");
    assert.strictEqual(formatTimeContext(instant, "Europe/Amsterdam"), "Sunday 00:05");
  });

  it("returns undefined for an invalid date", () => {
    assert.isUndefined(formatTimeContext(new Date("0000-00-00T00:00:00.000Z"), "UTC"));
    assert.isUndefined(formatTimeContext(new Date(Number.NaN), "UTC"));
  });

  it("returns undefined for a zone this runtime cannot format", () => {
    assert.isUndefined(formatTimeContext(MONDAY_MORNING, "Europe/Nowhere"));
    assert.isUndefined(formatTimeContext(MONDAY_MORNING, ""));
  });
});

describe("formatSince", () => {
  it("prefixes the time context with since", () => {
    assert.strictEqual(formatSince(MONDAY_MORNING, "UTC"), "since Monday 07:14");
  });

  it("returns undefined whenever the time context is undefined", () => {
    assert.isUndefined(formatSince(new Date("0000-00-00T00:00:00.000Z"), "UTC"));
    assert.isUndefined(formatSince(MONDAY_MORNING, "Europe/Nowhere"));
  });
});

describe("formatStamp", () => {
  /** 17:21 in Amsterdam on the fourth. */
  const instant = new Date("2026-09-04T15:21:31.646Z");

  it("formats an instant in the given zone, on a 24-hour clock", () => {
    assert.strictEqual(formatStamp(instant, "Europe/Amsterdam"), "4 Sep 17:21");
    assert.strictEqual(formatStamp(instant, "UTC"), "4 Sep 15:21");
  });

  it("returns undefined for an unusable zone or an invalid date", () => {
    assert.isUndefined(formatStamp(instant, "Europe/Nowhere"));
    assert.isUndefined(formatStamp(new Date(Number.NaN), "UTC"));
  });
});

describe("chooseStamps", () => {
  it("formats each instant in the given zone", () => {
    const stamps = chooseStamps(["2026-09-04T15:21:00.000Z", "2026-09-04T16:00:00.000Z"], "UTC");

    assert.deepStrictEqual(stamps, ["4 Sep 15:21", "4 Sep 16:00"]);
  });

  it("leaves out a stamp equal to the last one shown", () => {
    const stamps = chooseStamps(
      ["2026-09-04T15:21:05.000Z", "2026-09-04T15:21:50.000Z", "2026-09-04T15:22:00.000Z"],
      "UTC",
    );

    assert.deepStrictEqual(stamps, ["4 Sep 15:21", undefined, "4 Sep 15:22"]);
  });

  it("gives no stamp to a row with no time, and compares across it with the last one shown", () => {
    const stamps = chooseStamps(
      ["2026-09-04T15:21:05.000Z", null, "2026-09-04T15:21:50.000Z"],
      "UTC",
    );

    assert.deepStrictEqual(stamps, ["4 Sep 15:21", undefined, undefined]);
  });
});

describe("formatDay", () => {
  it("formats the day in the given zone", () => {
    // 23:30 on the eighth in UTC is already the ninth in Amsterdam.
    const instant = new Date("2026-10-08T23:30:00Z");
    assert.strictEqual(formatDay(instant, "Europe/Amsterdam"), "9 Oct");
    assert.strictEqual(formatDay(instant, "UTC"), "8 Oct");
  });

  it("returns undefined for an unusable zone or an invalid date", () => {
    assert.isUndefined(formatDay(MONDAY_MORNING, "Europe/Nowhere"));
    assert.isUndefined(formatDay(new Date(Number.NaN), "UTC"));
  });
});

describe("formatter caching", () => {
  /** How many `Intl.DateTimeFormat`s `run` builds. */
  const countFormattersBuilt = (run: () => void): number => {
    const original = Intl.DateTimeFormat;
    let count = 0;
    Intl.DateTimeFormat = new Proxy(original, {
      construct: (target, args: ConstructorParameters<typeof Intl.DateTimeFormat>) => {
        count += 1;
        return new target(...args);
      },
    });
    try {
      run();
    } finally {
      Intl.DateTimeFormat = original;
    }
    return count;
  };

  it("builds each formatter once per zone and format, however many rows are formatted", () => {
    // A zone no other test here uses, so no formatter is cached for it yet.
    const zone = "Pacific/Auckland";
    const rows = 50;

    const count = countFormattersBuilt(() => {
      for (let row = 0; row < rows; row += 1) {
        formatStamp(new Date(MONDAY_MORNING.getTime() + row * 60_000), zone);
        formatTimeContext(MONDAY_MORNING, zone);
      }
    });

    assert.strictEqual(count, 2);
    assert.strictEqual(formatStamp(MONDAY_MORNING, zone), "7 Sep 19:14");
  });

  it("does not retry a zone this runtime has already rejected", () => {
    const count = countFormattersBuilt(() => {
      assert.isUndefined(formatStamp(MONDAY_MORNING, "Europe/Atlantis"));
      assert.isUndefined(formatStamp(MONDAY_MORNING, "Europe/Atlantis"));
    });

    assert.strictEqual(count, 1);
  });
});

describe("formatPreciseStamp", () => {
  it("formats to the second in the given zone", () => {
    assert.strictEqual(
      formatPreciseStamp(new Date("2026-09-07T07:14:05Z"), "Europe/Amsterdam"),
      "7 Sep 09:14:05",
    );
  });

  it("leaves the day out when it is the day of the other instant, in the given zone", () => {
    const ended = new Date("2026-09-07T07:14:09Z");
    assert.strictEqual(formatPreciseStamp(ended, "UTC", MONDAY_MORNING), "07:14:09");
    // 23:30 UTC on the 6th is already the 7th in Amsterdam.
    const late = new Date("2026-09-06T23:30:00Z");
    assert.strictEqual(formatPreciseStamp(ended, "Europe/Amsterdam", late), "09:14:09");
    assert.strictEqual(formatPreciseStamp(ended, "UTC", late), "7 Sep 07:14:09");
  });

  it("keeps the day when the other instant is the same day of another year", () => {
    const lastYear = new Date("2025-09-07T07:14:00Z");
    assert.strictEqual(
      formatPreciseStamp(new Date("2026-09-07T07:14:09Z"), "UTC", lastYear),
      "7 Sep 07:14:09",
    );
  });
});

describe("isSameDay", () => {
  it("compares the calendar days in the given zone, not in UTC", () => {
    // 23:30 UTC on the 6th is already the 7th in Amsterdam.
    const late = new Date("2026-09-06T23:30:00Z");
    assert.isTrue(isSameDay(late, MONDAY_MORNING, "Europe/Amsterdam"));
    assert.isFalse(isSameDay(late, MONDAY_MORNING, "UTC"));
  });

  it("tells the same day of another year apart", () => {
    assert.isFalse(isSameDay(new Date("2025-09-07T07:14:00Z"), MONDAY_MORNING, "UTC"));
  });

  it("returns false for an invalid date or a zone this runtime cannot format", () => {
    assert.isFalse(isSameDay(new Date("not a date"), MONDAY_MORNING, "UTC"));
    assert.isFalse(isSameDay(MONDAY_MORNING, MONDAY_MORNING, "Not/A_Zone"));
  });
});

describe("formatDayStamp", () => {
  const NOW = new Date("2026-10-07T10:00:00Z");

  it('returns "Today" and "Yesterday" for the date of now and the date before it', () => {
    assert.strictEqual(formatDayStamp(new Date("2026-10-07T06:00:00Z"), "UTC", NOW), "Today");
    assert.strictEqual(formatDayStamp(new Date("2026-10-06T23:59:00Z"), "UTC", NOW), "Yesterday");
    assert.strictEqual(formatDayStamp(new Date("2026-10-06T00:00:00Z"), "UTC", NOW), "Yesterday");
  });

  it("returns the day and month for an earlier date in the same year", () => {
    assert.strictEqual(formatDayStamp(new Date("2026-10-05T23:59:00Z"), "UTC", NOW), "5 Oct");
    assert.strictEqual(formatDayStamp(new Date("2026-09-04T12:00:00Z"), "UTC", NOW), "4 Sep");
  });

  it("adds the year for a date in another year", () => {
    assert.strictEqual(formatDayStamp(new Date("2025-09-04T12:00:00Z"), "UTC", NOW), "4 Sep 2025");
  });

  it("returns the day and month for a date after now, as a clock that runs ahead gives", () => {
    assert.strictEqual(formatDayStamp(new Date("2026-10-08T12:00:00Z"), "UTC", NOW), "8 Oct");
  });

  it("reads the dates in the given zone, not in UTC", () => {
    // 01:00 UTC on the 7th is 10:00 on the 7th in Tokyo, but 18:00 on the
    // 6th in Los Angeles; now is 19:00 on the 7th in Tokyo and 03:00 on the
    // 7th in Los Angeles.
    const instant = new Date("2026-09-07T01:00:00Z");
    const now = new Date("2026-09-07T10:00:00Z");
    assert.strictEqual(formatDayStamp(instant, "Asia/Tokyo", now), "Today");
    assert.strictEqual(formatDayStamp(instant, "America/Los_Angeles", now), "Yesterday");
  });

  it('keeps "Yesterday" across a 25-hour day', () => {
    // Amsterdam's clocks go back an hour on 25 October 2026. At 23:30 that
    // day, 24 hours earlier is still 25 October, at 00:30.
    const now = new Date("2026-10-25T22:30:00Z");
    const lateOnThe24th = new Date("2026-10-24T21:00:00Z");
    const earlyOnThe25th = new Date("2026-10-24T22:10:00Z");
    assert.strictEqual(formatDayStamp(lateOnThe24th, "Europe/Amsterdam", now), "Yesterday");
    assert.strictEqual(formatDayStamp(earlyOnThe25th, "Europe/Amsterdam", now), "Today");
  });

  it('does not call two days ago "Yesterday" after a 23-hour day', () => {
    // Amsterdam's clocks go forward an hour on 29 March 2026. At 00:30 on the
    // 30th, 24 hours earlier is 23:30 on the 28th, two dates back.
    const now = new Date("2026-03-29T22:30:00Z");
    const lateOnThe28th = new Date("2026-03-28T22:30:00Z");
    const lateOnThe29th = new Date("2026-03-29T21:50:00Z");
    assert.strictEqual(formatDayStamp(lateOnThe28th, "Europe/Amsterdam", now), "28 Mar");
    assert.strictEqual(formatDayStamp(lateOnThe29th, "Europe/Amsterdam", now), "Yesterday");
  });

  it("takes the year from the zone at a new year", () => {
    // 23:30 UTC on 31 December 2025 is already 00:30 on 1 January 2026 in
    // Amsterdam.
    const instant = new Date("2025-12-31T23:30:00Z");
    const newYearsMorning = new Date("2026-01-01T10:00:00Z");
    assert.strictEqual(formatDayStamp(instant, "Europe/Amsterdam", newYearsMorning), "Today");
    assert.strictEqual(formatDayStamp(instant, "UTC", newYearsMorning), "Yesterday");
    assert.strictEqual(formatDayStamp(instant, "Europe/Amsterdam", NOW), "1 Jan");
    assert.strictEqual(formatDayStamp(instant, "UTC", NOW), "31 Dec 2025");
  });

  it("returns undefined for an invalid date or a zone this runtime cannot format", () => {
    assert.isUndefined(formatDayStamp(new Date("not a date"), "UTC", NOW));
    assert.isUndefined(formatDayStamp(NOW, "UTC", new Date(Number.NaN)));
    assert.isUndefined(formatDayStamp(NOW, "Not/A_Zone", NOW));
  });
});

describe("computeMinutesOfDay", () => {
  const AT = new Date("2026-10-07T21:10:00Z");

  it.each([
    ["UTC", 21 * 60 + 10],
    ["Europe/Amsterdam", 23 * 60 + 10],
    // Kolkata is UTC+05:30 and Kathmandu UTC+05:45; both are on the next day.
    ["Asia/Kolkata", 2 * 60 + 40],
    ["Asia/Kathmandu", 2 * 60 + 55],
    ["America/Los_Angeles", 14 * 60 + 10],
  ])("reads the time of day in %s", (timezone, minutes) => {
    assert.strictEqual(computeMinutesOfDay(AT, timezone), minutes);
  });

  it("reads midnight as 0, not 1440, in UTC and in another zone", () => {
    assert.strictEqual(computeMinutesOfDay(new Date("2026-10-07T00:00:00Z"), "UTC"), 0);
    assert.strictEqual(
      computeMinutesOfDay(new Date("2026-10-06T22:00:00Z"), "Europe/Amsterdam"),
      0,
    );
  });

  it("returns undefined for a zone this runtime does not know", () => {
    assert.isUndefined(computeMinutesOfDay(AT, "Mars/Olympus"));
  });
});
