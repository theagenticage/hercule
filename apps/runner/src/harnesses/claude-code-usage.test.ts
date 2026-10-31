/**
 * Tests how Claude Code's usage reports become readings. The `rate_limit_event`
 * infos are in the shape the pinned SDK documents (utilization as a fraction,
 * `resetsAt` in epoch seconds). The usage answers follow its usage read
 * (utilization as a percentage, `resets_at` as ISO-8601).
 */
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { UsageReading } from "@hercule/protocol";
import { buildRateLimitReadings, buildUsageAnswerReadings } from "./claude-code-usage";

const TAKEN_AT = "2026-10-31T09:00:00.000Z";
// 2026-10-31T12:00:00Z
const RESETS_AT_SECONDS = 1_793_448_000;
const RESETS_AT = "2026-10-31T12:00:00.000Z";

describe("the readings of a rate_limit_event", () => {
  it("reads the five-hour window", () => {
    const readings = buildRateLimitReadings(
      {
        status: "allowed",
        rateLimitType: "five_hour",
        utilization: 0.42,
        resetsAt: RESETS_AT_SECONDS,
      },
      TAKEN_AT,
    );

    expect(readings).toEqual([
      {
        kind: "window",
        window: "five-hour",
        usedPercent: 42,
        resetsAt: RESETS_AT,
        hit: false,
        takenAt: TAKEN_AT,
      },
    ]);
  });

  it("marks a rejected seven-day window as hit", () => {
    const readings = buildRateLimitReadings(
      {
        status: "rejected",
        rateLimitType: "seven_day",
        utilization: 1,
        resetsAt: RESETS_AT_SECONDS,
      },
      TAKEN_AT,
    );

    expect(readings).toEqual([
      {
        kind: "window",
        window: "weekly",
        usedPercent: 100,
        resetsAt: RESETS_AT,
        hit: true,
        takenAt: TAKEN_AT,
      },
    ]);
  });

  it("gives no reading when the event carries no utilization, and never invents 0", () => {
    expect(
      buildRateLimitReadings({ status: "allowed", rateLimitType: "five_hour" }, TAKEN_AT),
    ).toEqual([]);
  });

  it("gives no reading for a window it does not map", () => {
    for (const rateLimitType of [
      "seven_day_opus",
      "seven_day_sonnet",
      "seven_day_overage_included",
      "overage",
    ] as const) {
      expect(
        buildRateLimitReadings(
          { status: "allowed_warning", rateLimitType, utilization: 0.9 },
          TAKEN_AT,
        ),
      ).toEqual([]);
    }
  });

  it("gives no reading when the event names no window", () => {
    expect(buildRateLimitReadings({ status: "allowed", utilization: 0.5 }, TAKEN_AT)).toEqual([]);
  });

  it("limits a utilization above 1 to 100 percent", () => {
    const readings = buildRateLimitReadings(
      { status: "rejected", rateLimitType: "five_hour", utilization: 1.2 },
      TAKEN_AT,
    );

    expect(readings).toMatchObject([{ usedPercent: 100, hit: true, resetsAt: null }]);
  });

  it("gives every reading in a shape the protocol accepts", () => {
    const readings = buildRateLimitReadings(
      {
        status: "allowed",
        rateLimitType: "five_hour",
        utilization: 0.3,
        resetsAt: RESETS_AT_SECONDS,
      },
      TAKEN_AT,
    );

    for (const reading of readings) {
      expect(Schema.is(UsageReading)(reading)).toBe(true);
    }
  });

  it("gives no reset time for a time it cannot read", () => {
    const readings = buildRateLimitReadings(
      { status: "allowed", rateLimitType: "five_hour", utilization: 0.3, resetsAt: Number.NaN },
      TAKEN_AT,
    );

    expect(readings).toMatchObject([{ resetsAt: null }]);
  });
});

describe("the readings of a usage read", () => {
  const WINDOW = { utilization: 12.5, resets_at: "2026-10-31T12:00:00Z" };

  it("reads the five-hour and weekly windows", () => {
    const readings = buildUsageAnswerReadings(
      {
        rate_limits_available: true,
        rate_limits: {
          five_hour: WINDOW,
          seven_day: { utilization: 100, resets_at: "2026-11-02T00:00:00.000Z" },
          seven_day_opus: { utilization: 70, resets_at: RESETS_AT },
          seven_day_sonnet: { utilization: 80, resets_at: RESETS_AT },
        },
      },
      TAKEN_AT,
    );

    expect(readings).toEqual([
      {
        kind: "window",
        window: "five-hour",
        usedPercent: 12.5,
        resetsAt: RESETS_AT,
        hit: false,
        takenAt: TAKEN_AT,
      },
      {
        kind: "window",
        window: "weekly",
        usedPercent: 100,
        resetsAt: "2026-11-02T00:00:00.000Z",
        hit: true,
        takenAt: TAKEN_AT,
      },
    ]);
  });

  it("gives no reading for a window with no utilization", () => {
    const readings = buildUsageAnswerReadings(
      {
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: null, resets_at: null }, seven_day: null },
      },
      TAKEN_AT,
    );

    expect(readings).toEqual([]);
  });

  it("has no usage to give when plan limits do not apply", () => {
    expect(
      buildUsageAnswerReadings({ rate_limits_available: false, rate_limits: null }, TAKEN_AT),
    ).toBeNull();
    expect(
      buildUsageAnswerReadings({ rate_limits_available: true, rate_limits: null }, TAKEN_AT),
    ).toBeNull();
  });

  it("limits a utilization above 100 to 100 percent", () => {
    const readings = buildUsageAnswerReadings(
      {
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 130, resets_at: null } },
      },
      TAKEN_AT,
    );

    expect(readings).toMatchObject([{ usedPercent: 100, hit: true, resetsAt: null }]);
  });
});
