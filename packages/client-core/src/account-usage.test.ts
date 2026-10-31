/**
 * Tests `describeAccountUsage`: the lines a gauge draws for an account's
 * readings, their tones, their reset times and the "as of" time.
 */
import { describe, expect, it } from "vitest";
import type { AccountUsageReading } from "@hercule/contract";
import { describeAccountUsage } from "./account-usage";

const NOW = new Date("2026-10-31T10:50:00.000Z");
const TAKEN_AT = "2026-10-31T10:42:00.000Z";

const buildWindow = (
  window: "five-hour" | "weekly" | "monthly",
  fields: Partial<Extract<AccountUsageReading, { kind: "window" }>> = {},
): AccountUsageReading => ({
  kind: "window",
  window,
  usedPercent: 40,
  resetsAt: "2026-10-31T14:00:00.000Z",
  hit: false,
  takenAt: TAKEN_AT,
  source: "session",
  ...fields,
});

const describe_ = (usage: ReadonlyArray<AccountUsageReading>) =>
  describeAccountUsage({ usage }, "UTC", NOW);

describe("describeAccountUsage", () => {
  it("returns nothing for an account with no reading, so no gauge is drawn", () => {
    expect(describe_([])).toBeNull();
  });

  it("draws one line for each window, in the order the account lists them", () => {
    const usage = describe_([
      buildWindow("five-hour", { usedPercent: 61 }),
      buildWindow("weekly", { usedPercent: 38, resetsAt: "2026-11-02T09:00:00.000Z" }),
    ]);

    expect(usage?.lines).toEqual([
      {
        kind: "window",
        label: "5-hour",
        valueText: "61%",
        fillPercent: 61,
        tone: "normal",
        resetsText: "resets 14:00",
      },
      {
        kind: "window",
        label: "Weekly",
        valueText: "38%",
        fillPercent: 38,
        tone: "normal",
        resetsText: "resets Mon 09:00",
      },
    ]);
  });

  it("rounds the share, and turns a window to the attention tone from 80%", () => {
    const tones = describe_([
      buildWindow("five-hour", { usedPercent: 79.4 }),
      buildWindow("weekly", { usedPercent: 79.6 }),
      buildWindow("monthly", { usedPercent: 85 }),
    ])?.lines.map((line) => (line.kind === "window" ? [line.valueText, line.tone] : []));

    expect(tones).toEqual([
      ["79%", "normal"],
      ["80%", "attention"],
      ["85%", "attention"],
    ]);
  });

  it("shows a window that is hit as full, in the fail tone, whatever its share", () => {
    const [line] = describe_([buildWindow("five-hour", { usedPercent: 97, hit: true })])!.lines;

    expect(line).toMatchObject({ valueText: "Hit", fillPercent: 100, tone: "fail" });
  });

  it("leaves the reset time out when the reporter gave none", () => {
    const [line] = describe_([buildWindow("monthly", { resetsAt: null })])!.lines;

    expect(line).toMatchObject({ label: "Monthly", resetsText: null });
  });

  it("draws the credit as a number, with its limit when there is one", () => {
    const credit = (limit: number | null): AccountUsageReading => ({
      kind: "credit",
      remaining: 1240.5,
      limit,
      takenAt: TAKEN_AT,
      source: "read",
    });

    expect(describe_([credit(2000)])?.lines).toEqual([
      { kind: "credit", label: "Credits", remainingText: "1,240.5", limitText: "of 2,000" },
    ]);
    expect(describe_([credit(null)])?.lines[0]).toMatchObject({ limitText: null });
  });

  it("takes the as-of time from the newest reading, with its date when it is not today", () => {
    expect(
      describe_([
        buildWindow("five-hour", { takenAt: "2026-10-31T10:30:00.000Z" }),
        buildWindow("weekly", { takenAt: TAKEN_AT }),
      ])?.asOf,
    ).toBe("10:42");
    expect(describe_([buildWindow("weekly", { takenAt: "2026-10-29T08:05:00.000Z" })])?.asOf).toBe(
      "29 Oct 08:05",
    );
  });
});
