import { assert, describe, it } from "vitest";
import { formatSince, formatTimeContext } from "./time-context";

/** Monday 2026-09-07, 07:14 UTC. */
const MONDAY_MORNING = new Date("2026-09-07T07:14:00Z");

describe("formatTimeContext", () => {
  it("names the weekday and the 24-hour clock time in the zone given", () => {
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

  it("answers nothing for an instant that is not a date", () => {
    assert.isUndefined(formatTimeContext(new Date("0000-00-00T00:00:00.000Z"), "UTC"));
    assert.isUndefined(formatTimeContext(new Date(Number.NaN), "UTC"));
  });

  it("answers nothing for a zone this runtime cannot format", () => {
    assert.isUndefined(formatTimeContext(MONDAY_MORNING, "Europe/Nowhere"));
    assert.isUndefined(formatTimeContext(MONDAY_MORNING, ""));
  });
});

describe("formatSince", () => {
  it("prefixes the same reading", () => {
    assert.strictEqual(formatSince(MONDAY_MORNING, "UTC"), "since Monday 07:14");
  });

  it("answers nothing wherever the reading itself is nothing", () => {
    assert.isUndefined(formatSince(new Date("0000-00-00T00:00:00.000Z"), "UTC"));
    assert.isUndefined(formatSince(MONDAY_MORNING, "Europe/Nowhere"));
  });
});
