/**
 * Tests how the Z.ai quota answer becomes usage readings, against answers
 * written in the shape the endpoint documents: the five-hour and weekly token
 * windows, other limits that are dropped, and errors that come back as HTTP 200
 * with a business code.
 */
import { describe, expect, it } from "vitest";
import { parseQuotaBody } from "./quota";

const TAKEN_AT = "2026-10-31T12:00:00.000Z";

/** The five-hour token window of a Coding Plan, used 37 percent. */
const FIVE_HOUR = {
  type: "TOKENS_LIMIT",
  unit: 3,
  number: 5,
  usage: 40000000,
  currentValue: 14800000,
  remaining: 25200000,
  percentage: 37,
  nextResetTime: 1793448000000,
};

/** The weekly token window, used 12 percent. */
const WEEKLY = {
  type: "TOKENS_LIMIT",
  unit: 6,
  number: 1,
  percentage: 12,
  nextResetTime: 1793700000000,
};

/** The monthly MCP time limit, which is not shown. */
const MCP = {
  type: "TIME_LIMIT",
  unit: 5,
  number: 1,
  usage: 1000,
  currentValue: 3,
  remaining: 997,
  percentage: 1,
  nextResetTime: 1795000000000,
};

const answerWith = (limits: ReadonlyArray<object>) => ({
  code: 200,
  msg: "Operation successful",
  success: true,
  data: { limits, level: "pro" },
});

describe("parseQuotaBody", () => {
  it("reads the five-hour and weekly windows and drops the MCP limit", () => {
    expect(parseQuotaBody(answerWith([FIVE_HOUR, WEEKLY, MCP]), TAKEN_AT)).toEqual({
      readings: [
        {
          kind: "window",
          window: "five-hour",
          usedPercent: 37,
          resetsAt: "2026-10-31T12:00:00.000Z",
          hit: false,
          takenAt: TAKEN_AT,
        },
        {
          kind: "window",
          window: "weekly",
          usedPercent: 12,
          resetsAt: new Date(1793700000000).toISOString(),
          hit: false,
          takenAt: TAKEN_AT,
        },
      ],
    });
  });

  it("gives resetsAt null when the window has no nextResetTime", () => {
    const withoutReset: Record<string, unknown> = { ...FIVE_HOUR };
    delete withoutReset.nextResetTime;

    expect(parseQuotaBody(answerWith([withoutReset]), TAKEN_AT)).toMatchObject({
      readings: [{ window: "five-hour", usedPercent: 37, resetsAt: null }],
    });
    expect(
      parseQuotaBody(answerWith([{ ...FIVE_HOUR, nextResetTime: null }]), TAKEN_AT),
    ).toMatchObject({ readings: [{ resetsAt: null }] });
  });

  it("marks a window at 100 percent as hit, and limits a value above 100 to 100", () => {
    expect(
      parseQuotaBody(
        answerWith([
          { ...FIVE_HOUR, percentage: 100 },
          { ...WEEKLY, percentage: 104 },
        ]),
        TAKEN_AT,
      ),
    ).toMatchObject({
      readings: [
        { window: "five-hour", usedPercent: 100, hit: true },
        { window: "weekly", usedPercent: 100, hit: true },
      ],
    });
  });

  it("gives no reading for a window without a percentage, rather than an empty window", () => {
    const withoutPercentage: Record<string, unknown> = { ...FIVE_HOUR };
    delete withoutPercentage.percentage;

    expect(
      parseQuotaBody(answerWith([withoutPercentage, { ...WEEKLY, percentage: null }]), TAKEN_AT),
    ).toEqual({
      readings: [],
    });
  });

  it("drops token windows of a length it does not show, and the Team plan's credit limit", () => {
    expect(
      parseQuotaBody(
        answerWith([
          { ...FIVE_HOUR, number: 1 },
          { ...WEEKLY, number: 2 },
          { type: "TOKENS_LIMIT", unit: 5, number: 1, percentage: 5 },
          { type: "CREDIT_LIMIT", percentage: 50 },
        ]),
        TAKEN_AT,
      ),
    ).toEqual({ readings: [] });
  });

  it.each([
    [1000, "Authentication Failed"],
    [1003, "Authentication Token expired, please regenerate/obtain"],
  ])("refuses with Z.ai's words on the documented key failure code %s", (code, msg) => {
    expect(parseQuotaBody({ code, msg, success: false }, TAKEN_AT)).toEqual({ refused: msg });
  });

  // Recorded live on 2026-10-31 with a bogus key: HTTP 200 and this body, whether
  // the key was sent bare or with `Bearer`.
  it("refuses a recorded answer to a bogus key", () => {
    expect(
      parseQuotaBody({ code: 401, msg: "token expired or incorrect", success: false }, TAKEN_AT),
    ).toEqual({ refused: "token expired or incorrect" });
  });

  // Recorded live on 2026-10-31 by sending no Authorization header. That is
  // Hercule's own defect, so it must never mark a good key as failed.
  it("throws on the recorded answer to a missing Authorization header, which refuses no key", () => {
    expect(() =>
      parseQuotaBody(
        {
          code: 1001,
          msg: "Authentication parameter not received in Header, unable to authenticate",
          success: false,
        },
        TAKEN_AT,
      ),
    ).toThrow("code 1001");
  });

  it("throws on code 1005, two-factor authentication, which refuses no key", () => {
    expect(() =>
      parseQuotaBody(
        { code: 1005, msg: "Need Two-Factor Authentication", success: false },
        TAKEN_AT,
      ),
    ).toThrow("code 1005");
  });

  it("throws on a failure that says nothing about the key", () => {
    expect(() =>
      parseQuotaBody({ code: 1305, msg: "Too many requests", success: false }, TAKEN_AT),
    ).toThrow("code 1305: Too many requests");
  });

  it.each([
    ["a string", "nope"],
    ["null", null],
    ["a body without success", { code: 200, data: { limits: [] } }],
    ["a success without data", { code: 200, msg: "ok", success: true }],
    ["limits that are not a list", { code: 200, success: true, data: { limits: {} } }],
    ["a limit without a type", answerWith([{ unit: 3, number: 5, percentage: 1 }])],
    ["a percentage that is text", answerWith([{ ...FIVE_HOUR, percentage: "37" }])],
  ])("throws on %s, which is a defect of the plugin or of Z.ai", (_name, body) => {
    expect(() => parseQuotaBody(body, TAKEN_AT)).toThrow();
  });
});
