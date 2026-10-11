/** Tests the list time column's texts, when they change, and the start times of a run's page. */
import { assert, describe, it } from "vitest";
import {
  computeDayStart,
  findNextListTimeChange,
  formatListTime,
  formatStartTime,
} from "./list-time";

describe("computeDayStart", () => {
  const readStart = (instant: string, timezone: string): string | undefined =>
    computeDayStart(new Date(instant), timezone)?.toISOString();

  it("returns midnight of the date in the zone", () => {
    assert.strictEqual(readStart("2026-10-07T21:10:42.5Z", "UTC"), "2026-10-07T00:00:00.000Z");
    // 23:10 in Amsterdam; midnight there is 22:00 UTC the day before.
    assert.strictEqual(
      readStart("2026-10-07T21:10:00Z", "Europe/Amsterdam"),
      "2026-10-06T22:00:00.000Z",
    );
    // 02:55 the next day in Kathmandu, which is UTC+05:45.
    assert.strictEqual(
      readStart("2026-10-07T21:10:00Z", "Asia/Kathmandu"),
      "2026-10-07T18:15:00.000Z",
    );
  });

  it("returns midnight itself for an instant at midnight", () => {
    assert.strictEqual(
      readStart("2026-10-06T22:00:00Z", "Europe/Amsterdam"),
      "2026-10-06T22:00:00.000Z",
    );
  });

  it("finds midnight on a day the clock moves forward", () => {
    // 29 March 2026 in Amsterdam is 23 hours long: 02:00 CET becomes 03:00 CEST.
    // 10:00 CEST is 08:00 UTC, and midnight is still 23:00 UTC the day before.
    assert.strictEqual(
      readStart("2026-03-29T08:00:00Z", "Europe/Amsterdam"),
      "2026-03-28T23:00:00.000Z",
    );
  });

  it("finds midnight on a day the clock moves back, inside the repeated hour too", () => {
    // 25 October 2026 in Amsterdam is 25 hours long: 03:00 CEST becomes 02:00 CET.
    // Midnight is 22:00 UTC the day before, in summer time.
    assert.strictEqual(
      readStart("2026-10-25T09:00:00Z", "Europe/Amsterdam"),
      "2026-10-24T22:00:00.000Z",
    );
    // 02:30 the second time, in winter time.
    assert.strictEqual(
      readStart("2026-10-25T01:30:00Z", "Europe/Amsterdam"),
      "2026-10-24T22:00:00.000Z",
    );
  });

  it("returns the first instant of a date whose clock skips midnight", () => {
    // In Santiago on 6 September 2026, 00:00 becomes 01:00, so the date
    // starts at 01:00 local, which is 04:00 UTC.
    assert.strictEqual(
      readStart("2026-09-06T13:00:00Z", "America/Santiago"),
      "2026-09-06T04:00:00.000Z",
    );
  });

  it("returns the first midnight of a date whose clock reads midnight twice", () => {
    // In Havana on 1 November 2026, 01:00 CDT becomes 00:00 CST: the date
    // starts at 00:00 CDT, 04:00 UTC, and the clock reads 00:00 again at
    // 05:00 UTC.
    assert.strictEqual(
      readStart("2026-11-01T16:00:00Z", "America/Havana"),
      "2026-11-01T04:00:00.000Z",
    );
    assert.strictEqual(
      readStart("2026-11-01T05:30:00Z", "America/Havana"),
      "2026-11-01T04:00:00.000Z",
    );
  });

  it("returns undefined for an invalid date or a zone this runtime does not know", () => {
    assert.isUndefined(computeDayStart(new Date("not a date"), "UTC"));
    assert.isUndefined(computeDayStart(new Date("2026-10-07T21:10:00Z"), "Mars/Olympus"));
  });
});

/** Wednesday 2026-10-07, 23:10 in Amsterdam and 21:10 in UTC. */
const WEDNESDAY_NIGHT = new Date("2026-10-07T21:10:00Z");

describe("formatListTime", () => {
  const formatPast = (instant: string, timezone = "Europe/Amsterdam"): string | undefined =>
    formatListTime(new Date(instant), timezone, WEDNESDAY_NIGHT, "past");
  const formatFuture = (instant: string, timezone = "Europe/Amsterdam"): string | undefined =>
    formatListTime(new Date(instant), timezone, WEDNESDAY_NIGHT, "future");

  it("formats an instant on the date of now as its time", () => {
    assert.strictEqual(formatPast("2026-10-07T08:31:00Z"), "10:31");
    assert.strictEqual(formatFuture("2026-10-07T21:40:00Z"), "23:40");
  });

  it("formats a past instant within the six dates before now as its weekday alone", () => {
    assert.strictEqual(formatPast("2026-10-06T08:31:00Z"), "Tue");
    assert.strictEqual(formatPast("2026-10-01T08:31:00Z"), "Thu");
  });

  it("formats a future instant within the six dates after now as its weekday and time", () => {
    assert.strictEqual(formatFuture("2026-10-09T12:00:00Z"), "Fri 14:00");
    assert.strictEqual(formatFuture("2026-10-13T12:00:00Z"), "Tue 14:00");
  });

  it("formats an instant a week or more away as its date, with the year when it differs", () => {
    assert.strictEqual(formatPast("2026-09-30T08:31:00Z"), "30 Sep");
    assert.strictEqual(formatFuture("2026-10-14T12:00:00Z"), "14 Oct");
    assert.strictEqual(formatPast("2025-10-01T08:31:00Z"), "1 Oct 2025");
    assert.strictEqual(formatFuture("2027-01-04T12:00:00Z"), "4 Jan 2027");
  });

  it("formats an instant on the wrong side of now as its date", () => {
    assert.strictEqual(formatPast("2026-10-08T08:31:00Z"), "8 Oct");
    assert.strictEqual(formatFuture("2026-10-06T08:31:00Z"), "6 Oct");
  });

  it("reads the dates in the zone, not in UTC", () => {
    // 22:30 UTC is still the seventh in UTC, and already the eighth in Amsterdam.
    assert.strictEqual(formatFuture("2026-10-07T22:30:00Z", "UTC"), "22:30");
    assert.strictEqual(formatFuture("2026-10-07T22:30:00Z"), "Thu 00:30");
  });

  it("returns undefined for an invalid instant or zone", () => {
    assert.isUndefined(formatPast("not a date"));
    assert.isUndefined(formatPast("2026-10-07T08:31:00Z", "Europe/Nowhere"));
  });
});

describe("findNextListTimeChange", () => {
  const findChange = (
    instant: string,
    now: string,
    direction: "past" | "future" = "past",
    timezone = "Europe/Amsterdam",
  ): string =>
    findNextListTimeChange(new Date(instant), timezone, new Date(now), direction).toISOString();

  it("returns the next midnight in the zone, when the text moves on", () => {
    const instant = new Date("2026-10-07T08:31:00Z");
    const change = findNextListTimeChange(instant, "Europe/Amsterdam", WEDNESDAY_NIGHT, "past");

    assert.strictEqual(change.toISOString(), "2026-10-07T22:00:00.000Z");
    assert.strictEqual(
      formatListTime(instant, "Europe/Amsterdam", WEDNESDAY_NIGHT, "past"),
      "10:31",
    );
    assert.strictEqual(formatListTime(instant, "Europe/Amsterdam", change, "past"), "Wed");
  });

  it("returns the midnight after next once now is past midnight, never now itself", () => {
    assert.strictEqual(
      findChange("2026-10-07T08:31:00Z", "2026-10-07T22:05:00Z"),
      "2026-10-08T22:00:00.000Z",
    );
    assert.strictEqual(
      findChange("2026-10-07T08:31:00Z", "2026-10-07T22:00:00Z"),
      "2026-10-08T22:00:00.000Z",
    );
  });

  it("finds midnight across the days the clock moves for daylight saving time", () => {
    // 29 March 2026 in Amsterdam is 23 hours long; the next midnight is in summer time.
    assert.strictEqual(
      findChange("2026-03-29T06:00:00Z", "2026-03-29T08:00:00Z"),
      "2026-03-29T22:00:00.000Z",
    );
    // 25 October 2026 in Amsterdam is 25 hours long; the next midnight is in winter time.
    assert.strictEqual(
      findChange("2026-10-25T06:00:00Z", "2026-10-25T01:30:00Z"),
      "2026-10-25T23:00:00.000Z",
    );
  });

  it("finds the first midnight of a date whose clock reads midnight twice", () => {
    // Havana's clock reads 00:00 on 1 November 2026 at 04:00 UTC and again at
    // 05:00 UTC; the date, and so the text, changes at the first.
    assert.strictEqual(
      findChange("2026-10-31T12:00:00Z", "2026-10-31T22:00:00Z", "past", "America/Havana"),
      "2026-11-01T04:00:00.000Z",
    );
  });

  it("finds the midnight that starts a new year", () => {
    assert.strictEqual(
      findChange("2026-12-31T08:00:00Z", "2026-12-31T15:00:00Z", "past", "UTC"),
      "2027-01-01T00:00:00.000Z",
    );
  });

  it("returns a future instant itself when it comes before the next midnight", () => {
    assert.strictEqual(
      findChange("2026-10-07T21:30:00Z", "2026-10-07T21:10:00Z", "future"),
      "2026-10-07T21:30:00.000Z",
    );
    assert.strictEqual(
      findChange("2026-10-09T12:00:00Z", "2026-10-07T21:10:00Z", "future"),
      "2026-10-07T22:00:00.000Z",
    );
    assert.strictEqual(
      findChange("2026-10-07T21:00:00Z", "2026-10-07T21:10:00Z", "future"),
      "2026-10-07T22:00:00.000Z",
    );
  });

  it("returns the latest moment a date can hold for an invalid instant or zone", () => {
    assert.strictEqual(
      findChange("not a date", "2026-10-07T21:10:00Z"),
      "+275760-09-13T00:00:00.000Z",
    );
    assert.strictEqual(
      findChange("2026-10-07T08:31:00Z", "2026-10-07T21:10:00Z", "past", "Europe/Nowhere"),
      "+275760-09-13T00:00:00.000Z",
    );
  });
});

describe("formatStartTime", () => {
  // A Friday afternoon in Amsterdam, two hours ahead of UTC.
  const NOW = new Date("2026-09-25T12:00:00.000Z");
  const ZONE = "Europe/Amsterdam";

  it("says Today for a start on the same local date", () => {
    assert.strictEqual(
      formatStartTime(new Date("2026-09-25T08:31:00.000Z"), ZONE, NOW),
      "Today 10:31",
    );
    // Half past ten on Thursday in UTC is already Friday in Amsterdam.
    assert.strictEqual(
      formatStartTime(new Date("2026-09-24T22:30:00.000Z"), ZONE, NOW),
      "Today 00:30",
    );
  });

  it("gives the weekday within the week before, and the date before that", () => {
    assert.strictEqual(
      formatStartTime(new Date("2026-09-22T12:00:00.000Z"), ZONE, NOW),
      "Tue 14:00",
    );
    assert.strictEqual(
      formatStartTime(new Date("2026-09-11T12:00:00.000Z"), ZONE, NOW),
      "11 Sep 14:00",
    );
  });

  it("returns undefined for an instant that is not a date", () => {
    assert.isUndefined(formatStartTime(new Date(Number.NaN), ZONE, NOW));
  });
});
