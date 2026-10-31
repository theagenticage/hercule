/**
 * Tests how the answer of OpenCode Go's usage endpoint becomes usage
 * readings. The first answer is a real one; the others change one thing in it
 * or follow the shape of OpenCode's own route.
 */
import { describe, expect, it } from "vitest";
import { parseGoUsageBody } from "./usage";

const TAKEN_AT = "2026-10-31T12:00:00.000Z";

/**
 * A response recorded by a user of OpenCode Go and posted in
 * https://github.com/anomalyco/opencode/issues/50085.
 */
const RECORDED = {
  usage: {
    rolling: { status: "ok", percent: 5, resetsAt: "2026-09-19T19:10:07.880Z" },
    weekly: { status: "ok", percent: 46, resetsAt: "2026-09-21T00:00:00.880Z" },
    monthly: { status: "ok", percent: 41, resetsAt: "2026-10-08T05:27:23.880Z" },
  },
};

describe("parseGoUsageBody", () => {
  it("reads the rolling, weekly and monthly windows of a recorded answer", () => {
    expect(parseGoUsageBody(RECORDED, TAKEN_AT)).toEqual({
      readings: [
        {
          kind: "window",
          window: "five-hour",
          usedPercent: 5,
          resetsAt: "2026-09-19T19:10:07.880Z",
          hit: false,
          takenAt: TAKEN_AT,
        },
        {
          kind: "window",
          window: "weekly",
          usedPercent: 46,
          resetsAt: "2026-09-21T00:00:00.880Z",
          hit: false,
          takenAt: TAKEN_AT,
        },
        {
          kind: "window",
          window: "monthly",
          usedPercent: 41,
          resetsAt: "2026-10-08T05:27:23.880Z",
          hit: false,
          takenAt: TAKEN_AT,
        },
      ],
    });
  });

  it("marks a rate-limited window as hit even below 100 percent, and keeps its percent", () => {
    const body = {
      usage: { ...RECORDED.usage, weekly: { ...RECORDED.usage.weekly, status: "rate-limited" } },
    };

    expect(parseGoUsageBody(body, TAKEN_AT)).toMatchObject({
      readings: [
        { window: "five-hour", hit: false },
        { window: "weekly", usedPercent: 46, hit: true },
        { window: "monthly", hit: false },
      ],
    });
  });

  it("limits percentages to 0-100 and marks a window at 100 percent as hit", () => {
    const body = {
      usage: {
        rolling: { ...RECORDED.usage.rolling, percent: 100 },
        weekly: { ...RECORDED.usage.weekly, percent: 130 },
        monthly: { ...RECORDED.usage.monthly, percent: -4 },
      },
    };

    expect(parseGoUsageBody(body, TAKEN_AT)).toMatchObject({
      readings: [
        { window: "five-hour", usedPercent: 100, hit: true },
        { window: "weekly", usedPercent: 100, hit: true },
        { window: "monthly", usedPercent: 0, hit: false },
      ],
    });
  });

  it("gives no reading for a window that is missing, and still reads the others", () => {
    const { rolling, weekly } = RECORDED.usage;

    expect(parseGoUsageBody({ usage: { rolling, weekly } }, TAKEN_AT)).toMatchObject({
      readings: [{ window: "five-hour" }, { window: "weekly" }],
    });
    expect(parseGoUsageBody({ usage: {} }, TAKEN_AT)).toEqual({ readings: [] });
  });

  it("gives no reading for a window without a percent, and still reads the others", () => {
    const { weekly, monthly } = RECORDED.usage;
    const body = { usage: { rolling: { status: "ok" }, weekly, monthly } };

    expect(parseGoUsageBody(body, TAKEN_AT)).toMatchObject({
      readings: [{ window: "weekly" }, { window: "monthly" }],
    });
  });

  it("reads a window without a status as not rate-limited", () => {
    expect(parseGoUsageBody({ usage: { rolling: { percent: 5 } } }, TAKEN_AT)).toMatchObject({
      readings: [{ window: "five-hour", usedPercent: 5, hit: false }],
    });
  });

  it("gives resetsAt null when the reset time is missing or not a date", () => {
    const body = {
      usage: {
        rolling: { status: "ok", percent: 5 },
        weekly: { ...RECORDED.usage.weekly, resetsAt: "soon" },
        monthly: RECORDED.usage.monthly,
      },
    };

    expect(parseGoUsageBody(body, TAKEN_AT)).toMatchObject({
      readings: [{ resetsAt: null }, { resetsAt: null }, { resetsAt: "2026-10-08T05:27:23.880Z" }],
    });
  });

  it("normalizes a reset time written with another offset to UTC", () => {
    const body = {
      usage: { rolling: { status: "ok", percent: 1, resetsAt: "2026-09-19T21:10:07+02:00" } },
    };

    expect(parseGoUsageBody(body, TAKEN_AT)).toMatchObject({
      readings: [{ resetsAt: "2026-09-19T19:10:07.000Z" }],
    });
  });

  it.each([
    ["a string", "nope"],
    ["null", null],
    ["a body without usage", {}],
    ["an error body", { type: "error", error: { type: "EntitlementError", message: "no" } }],
    ["a percent that is text", { usage: { rolling: { status: "ok", percent: "5" } } }],
    ["a status that is a number", { usage: { rolling: { status: 1, percent: 5 } } }],
    ["a window that is not an object", { usage: { rolling: 5 } }],
  ])("throws on %s, which is a defect of the plugin or of OpenCode", (_name, body) => {
    expect(() => parseGoUsageBody(body, TAKEN_AT)).toThrow();
  });
});
