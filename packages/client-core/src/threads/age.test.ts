/**
 * `formatAge(at, now)` reads how long since `at`, at the coarsest unit that fits.
 */
import { describe, expect, it } from "vitest";
import { formatAge } from "./age";

const NOW = new Date("2026-09-08T12:00:00.000Z");

describe("formatAge", () => {
  it("reads under a minute as now", () => {
    expect(formatAge("2026-09-08T11:59:31.000Z", NOW)).toBe("now");
    expect(formatAge(NOW.toISOString(), NOW)).toBe("now");
  });

  it("reads in minutes under an hour", () => {
    expect(formatAge("2026-09-08T11:55:00.000Z", NOW)).toBe("5m");
    expect(formatAge("2026-09-08T11:01:00.000Z", NOW)).toBe("59m");
  });

  it("reads in hours under a day", () => {
    expect(formatAge("2026-09-08T09:00:00.000Z", NOW)).toBe("3h");
    expect(formatAge("2026-09-07T13:00:00.000Z", NOW)).toBe("23h");
  });

  it("reads in days under a week", () => {
    expect(formatAge("2026-09-06T12:00:00.000Z", NOW)).toBe("2d");
    expect(formatAge("2026-09-02T00:00:00.000Z", NOW)).toBe("6d");
  });

  it("reads in weeks from seven days on", () => {
    expect(formatAge("2026-08-18T12:00:00.000Z", NOW)).toBe("3w");
    expect(formatAge("2026-09-01T12:00:00.000Z", NOW)).toBe("1w");
  });

  it("carries no seconds precision", () => {
    expect(formatAge("2026-09-08T11:55:59.000Z", NOW)).toBe("4m");
  });

  it("never reads negative for an instant after now", () => {
    expect(formatAge("2026-09-08T12:05:00.000Z", NOW)).toBe("now");
  });
});
