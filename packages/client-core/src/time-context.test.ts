import { assert, describe, it } from "vitest";
import { formatSince, formatStamp, formatTimeContext } from "./time-context";

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

describe("formatStamp", () => {
  /** 17:21 in Amsterdam on the fourth. */
  const instant = new Date("2026-09-04T15:21:31.646Z");

  it("reads a moment in the zone given, on a 24-hour clock", () => {
    assert.strictEqual(formatStamp(instant, "Europe/Amsterdam"), "4 Sep 17:21");
    assert.strictEqual(formatStamp(instant, "UTC"), "4 Sep 15:21");
  });

  it("answers nothing for a zone it cannot format or a moment that is not one", () => {
    assert.isUndefined(formatStamp(instant, "Europe/Nowhere"));
    assert.isUndefined(formatStamp(new Date(Number.NaN), "UTC"));
  });
});

describe("the formatters these readings need", () => {
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

  it("are built once per zone and reading, however many rows are read", () => {
    // A zone no other test here asks for, so nothing is held for it yet.
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

  it("does not rebuild for a zone this runtime has already refused", () => {
    const count = countFormattersBuilt(() => {
      assert.isUndefined(formatStamp(MONDAY_MORNING, "Europe/Atlantis"));
      assert.isUndefined(formatStamp(MONDAY_MORNING, "Europe/Atlantis"));
    });

    assert.strictEqual(count, 1);
  });
});
