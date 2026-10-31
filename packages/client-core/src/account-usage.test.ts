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

const buildCredit = (fields: {
  remaining: number;
  limit: number | null;
  takenAt?: string;
}): AccountUsageReading => ({
  kind: "credit",
  takenAt: TAKEN_AT,
  source: "read",
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
        tooltip: "61% used, 5-hour window, resets 14:00",
      },
      {
        kind: "window",
        label: "Weekly",
        valueText: "38%",
        fillPercent: 38,
        tone: "normal",
        resetsText: "resets Mon 09:00",
        tooltip: "38% used, Weekly window, resets Mon 09:00",
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

    expect(line).toMatchObject({
      valueText: "Hit",
      fillPercent: 100,
      tone: "fail",
      tooltip: "Limit reached, 5-hour window, resets 14:00",
    });
  });

  it("leaves the reset time out when the reporter gave none", () => {
    const [line] = describe_([buildWindow("monthly", { resetsAt: null })])!.lines;

    expect(line).toMatchObject({
      label: "Monthly",
      resetsText: null,
      tooltip: "40% used, Monthly window",
    });
  });

  it("draws the credit as a number, with its limit when there is one", () => {
    expect(describe_([buildCredit({ remaining: 1240.5, limit: 2000 })])?.lines).toEqual([
      {
        kind: "credit",
        label: "Credits",
        remainingText: "1,240.5",
        suffixText: "of 2,000 credits left",
        text: "1,240.5 of 2,000 credits left",
      },
    ]);
    expect(describe_([buildCredit({ remaining: 1240, limit: null })])?.lines).toEqual([
      {
        kind: "credit",
        label: "Credits",
        remainingText: "1,240",
        suffixText: "credits left",
        text: "1,240 credits left",
      },
    ]);
  });

  it("draws no line for a credit of zero with no limit, and shows zero beside a limit", () => {
    expect(describe_([buildCredit({ remaining: 0, limit: null })])).toBeNull();
    expect(describe_([buildCredit({ remaining: 0, limit: 2000 })])?.lines).toMatchObject([
      { text: "0 of 2,000 credits left" },
    ]);
  });

  it("keeps the other lines when a zero credit is left out, and takes the as-of time from the lines drawn", () => {
    const gauge = describe_([
      buildWindow("weekly", { takenAt: "2026-10-31T10:30:00.000Z" }),
      buildCredit({ remaining: 0, limit: null, takenAt: TAKEN_AT }),
    ]);

    expect(gauge?.lines.map((line) => line.label)).toEqual(["Weekly"]);
    expect(gauge?.asOf).toBe("10:30");
  });

  it("writes a large credit short, so it cannot widen the card", () => {
    const text = (remaining: number, limit: number | null = null): string | undefined => {
      const [line] = describe_([buildCredit({ remaining, limit })])?.lines ?? [];
      return line?.kind === "credit" ? line.text : undefined;
    };

    expect(text(999_999)).toBe("999,999 credits left");
    expect(text(1_234_567)).toBe("1.2M credits left");
    expect(text(1_500_000_000, 2_000_000_000)).toBe("1.5B of 2B credits left");
    expect(text(1e308)).toBe("1E308 credits left");
    expect(text(Number.MAX_VALUE)).toBe("1.8E308 credits left");
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
