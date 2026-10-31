/**
 * Tests how MiniMax's plan usage answer becomes usage readings: a recorded
 * sample from MiniMax's own command line tool, windows that are unlimited or
 * exhausted, and errors that come back as HTTP 200 with a status code.
 */
import { describe, expect, it } from "vitest";
import { parsePlanUsageBody } from "./usage";

const TAKEN_AT = "2026-10-31T12:00:00.000Z";

/**
 * The sample answer in MiniMax's command line tool
 * (https://github.com/MiniMax-AI/cli, `test/fixtures/quota-response.json`,
 * commit a4bbafcbd4860e8984ed18cd0fa0eaf32a1d29ae, MIT licence). The text row
 * has 228 of 1500 left in the five-hour window and no weekly limit counts.
 */
const MINIMAX_CLI_SAMPLE = {
  base_resp: { status_code: 0, status_msg: "success" },
  model_remains: [
    {
      model_name: "MiniMax-M*",
      start_time: 1776355200000,
      end_time: 1776373200000,
      remains_time: 7151954,
      current_interval_total_count: 1500,
      current_interval_usage_count: 228,
      current_weekly_total_count: 0,
      current_weekly_usage_count: 0,
      weekly_start_time: 1776009600000,
      weekly_end_time: 1776614400000,
      weekly_remains_time: 248351954,
    },
    {
      model_name: "speech-hd",
      start_time: 1776355200000,
      end_time: 1776441600000,
      remains_time: 75551954,
      current_interval_total_count: 9000,
      current_interval_usage_count: 0,
      current_weekly_total_count: 63000,
      current_weekly_usage_count: 0,
      weekly_start_time: 1776009600000,
      weekly_end_time: 1776614400000,
      weekly_remains_time: 248351954,
    },
    {
      model_name: "image-01",
      start_time: 1776355200000,
      end_time: 1776441600000,
      remains_time: 75551954,
      current_interval_total_count: 100,
      current_interval_usage_count: 0,
      current_weekly_total_count: 700,
      current_weekly_usage_count: 0,
      weekly_start_time: 1776009600000,
      weekly_end_time: 1776614400000,
      weekly_remains_time: 248351954,
    },
  ],
};

/**
 * The answer of a newer plan. The row is the one recorded in MiniMax's command
 * line tool issue https://github.com/MiniMax-AI/cli/issues/165 (fixed there in
 * 1.0.16); the issue shows only the row, so the `base_resp` around it is the
 * one every successful answer has. The text row is named `general`, has no
 * counts, and gives the time left in each window instead of its end.
 */
const NEWER_PLAN_ANSWER = {
  base_resp: { status_code: 0 },
  model_remains: [
    {
      model_name: "general",
      current_interval_remaining_percent: 99,
      current_weekly_remaining_percent: 99,
      remains_time: 14998196,
      weekly_remains_time: 547798196,
    },
  ],
};

/** The text row of the sample, which the tests change one field at a time. */
const TEXT_ROW = MINIMAX_CLI_SAMPLE.model_remains[0]!;

const answerWith = (row: object) => ({
  base_resp: { status_code: 0, status_msg: "success" },
  model_remains: [{ ...TEXT_ROW, ...row }],
});

describe("parsePlanUsageBody", () => {
  it("reads only the text row of the sample: the usage count is what is left, so 228 of 1500 left is 84.8 percent used", () => {
    const result = parsePlanUsageBody(MINIMAX_CLI_SAMPLE, TAKEN_AT);

    if (!("readings" in result)) throw new Error("the sample was expected to give readings");
    expect(result.readings).toHaveLength(1);
    const [reading] = result.readings;
    // 100 - 228 / 1500 * 100 is not exact in floating point.
    expect(reading).toMatchObject({
      kind: "window",
      window: "five-hour",
      resetsAt: "2026-04-16T21:00:00.000Z",
      hit: false,
      takenAt: TAKEN_AT,
    });
    expect(reading?.kind === "window" ? reading.usedPercent : undefined).toBeCloseTo(84.8, 6);
  });

  it("reads the `general` row of a newer plan, with reset times from the time left", () => {
    expect(parsePlanUsageBody(NEWER_PLAN_ANSWER, TAKEN_AT)).toEqual({
      readings: [
        {
          kind: "window",
          window: "five-hour",
          usedPercent: 1,
          // 12:00:00.000 plus 14998196 ms.
          resetsAt: "2026-10-31T16:09:58.196Z",
          hit: false,
          takenAt: TAKEN_AT,
        },
        {
          kind: "window",
          window: "weekly",
          usedPercent: 1,
          // 12:00:00.000 plus 547798196 ms.
          resetsAt: "2026-11-06T20:09:58.196Z",
          hit: false,
          takenAt: TAKEN_AT,
        },
      ],
    });
  });

  it("prefers the `general` row over a MiniMax-M row in the same answer, and the end time over the time left", () => {
    const body = {
      base_resp: { status_code: 0 },
      model_remains: [
        TEXT_ROW,
        {
          model_name: "general",
          current_interval_remaining_percent: 70,
          end_time: 1776373200000,
          remains_time: 1000,
        },
      ],
    };

    expect(parsePlanUsageBody(body, TAKEN_AT)).toEqual({
      readings: [
        {
          kind: "window",
          window: "five-hour",
          usedPercent: 30,
          resetsAt: "2026-04-16T21:00:00.000Z",
          hit: false,
          takenAt: TAKEN_AT,
        },
      ],
    });
  });

  it("gives resetsAt null when a window has neither an end time nor a time left", () => {
    const body = {
      base_resp: { status_code: 0 },
      model_remains: [{ model_name: "general", current_interval_remaining_percent: 50 }],
    };

    expect(parsePlanUsageBody(body, TAKEN_AT)).toMatchObject({
      readings: [{ window: "five-hour", usedPercent: 50, resetsAt: null }],
    });
  });

  it("reads the weekly window, and prefers the remaining percent over the counts", () => {
    expect(
      parsePlanUsageBody(
        answerWith({
          current_interval_remaining_percent: 40,
          current_weekly_total_count: 5000,
          current_weekly_usage_count: 1000,
          current_weekly_remaining_percent: 25,
        }),
        TAKEN_AT,
      ),
    ).toEqual({
      readings: [
        {
          kind: "window",
          window: "five-hour",
          usedPercent: 60,
          resetsAt: "2026-04-16T21:00:00.000Z",
          hit: false,
          takenAt: TAKEN_AT,
        },
        {
          kind: "window",
          window: "weekly",
          usedPercent: 75,
          resetsAt: "2026-04-19T16:00:00.000Z",
          hit: false,
          takenAt: TAKEN_AT,
        },
      ],
    });
  });

  it("gives no weekly reading for an unlimited weekly window, which is not a window that is used up", () => {
    const body = answerWith({
      current_weekly_total_count: 0,
      current_weekly_remaining_percent: 0,
      current_weekly_status: 3,
    });

    expect(parsePlanUsageBody(body, TAKEN_AT)).toEqual({
      readings: [expect.objectContaining({ window: "five-hour" })],
    });
  });

  it("marks an exhausted window as hit at 100 percent, even when the counts are missing", () => {
    expect(
      parsePlanUsageBody(
        answerWith({
          current_interval_status: 2,
          current_interval_total_count: 0,
          current_weekly_remaining_percent: 0,
          current_weekly_total_count: 5000,
        }),
        TAKEN_AT,
      ),
    ).toMatchObject({
      readings: [
        { window: "five-hour", usedPercent: 100, hit: true },
        { window: "weekly", usedPercent: 100, hit: true },
      ],
    });
  });

  it("gives no reading for a window with no percent and a total of 0, and none when there is no text row", () => {
    expect(parsePlanUsageBody(answerWith({ current_interval_total_count: 0 }), TAKEN_AT)).toEqual({
      readings: [],
    });
    expect(
      parsePlanUsageBody(
        { ...MINIMAX_CLI_SAMPLE, model_remains: MINIMAX_CLI_SAMPLE.model_remains.slice(1) },
        TAKEN_AT,
      ),
    ).toEqual({ readings: [] });
  });

  it("refuses the recorded answer to a bogus key, which is HTTP 200", () => {
    expect(
      parsePlanUsageBody(
        {
          base_resp: {
            status_code: 1004,
            status_msg:
              "login fail: Please carry the API secret key in the 'Authorization' field of the request header",
          },
        },
        TAKEN_AT,
      ),
    ).toEqual({
      refused:
        "login fail: Please carry the API secret key in the 'Authorization' field of the request header",
    });
  });

  it("refuses with MiniMax's words on the documented key failure code 2049", () => {
    expect(
      parsePlanUsageBody(
        { base_resp: { status_code: 2049, status_msg: "invalid api key" } },
        TAKEN_AT,
      ),
    ).toEqual({ refused: "invalid api key" });
  });

  it("refuses code 2057 with words that say what to do, not MiniMax's own", () => {
    expect(
      parsePlanUsageBody(
        { base_resp: { status_code: 2057, status_msg: "not token plan token" } },
        TAKEN_AT,
      ),
    ).toEqual({
      refused:
        "This is a pay-as-you-go key, not a plan key. Add it to MiniMax as a pay-as-you-go key.",
    });
  });

  it.each([
    [2062, "no active M Plan subscription"],
    [1002, "rate limit"],
  ])("throws on code %s, which says nothing about the key", (code, message) => {
    expect(() =>
      parsePlanUsageBody({ base_resp: { status_code: code, status_msg: message } }, TAKEN_AT),
    ).toThrow(`status_code ${code}: ${message}`);
  });

  it.each([
    ["a body without base_resp", { model_remains: [] }],
    ["a success without model_remains", { base_resp: { status_code: 0 } }],
    ["a count that is text", answerWith({ current_interval_usage_count: "228" })],
  ])("throws on %s, which is a defect of the plugin or of MiniMax", (_name, body) => {
    expect(() => parsePlanUsageBody(body, TAKEN_AT)).toThrow();
  });
});
