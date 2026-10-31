/**
 * Tests for turning Codex's rate limits into usage readings. The snapshots are
 * shaped like the generated `RateLimitSnapshot`, not invented fields.
 */
import { describe, expect, it } from "vitest";
import { buildUsageReadings, pickCodexSnapshot, pickUpdatedSnapshot } from "./usage";
import type { GetAccountRateLimitsResponse, RateLimitSnapshot } from "./types";

const TAKEN_AT = "2026-10-31T12:00:00.000Z";

/** 2026-10-31T17:00:00Z and 2026-11-05T09:30:00Z, in epoch seconds. */
const FIVE_HOUR_RESET = 1_793_466_000;
const WEEKLY_RESET = 1_793_871_000;

const buildSnapshot = (overrides: Partial<RateLimitSnapshot> = {}): RateLimitSnapshot => ({
  limitId: "codex",
  limitName: null,
  normalModelSlug: null,
  primary: null,
  secondary: null,
  credits: null,
  individualLimit: null,
  spendControlReached: null,
  planType: "plus",
  rateLimitReachedType: null,
  ...overrides,
});

const PLUS = buildSnapshot({
  primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: FIVE_HOUR_RESET },
  secondary: { usedPercent: 7, windowDurationMins: 10_080, resetsAt: WEEKLY_RESET },
});

describe("the readings of a snapshot", () => {
  it("reads the five-hour and weekly windows of a Plus account, with their reset times", () => {
    expect(buildUsageReadings(PLUS, TAKEN_AT)).toEqual([
      {
        kind: "window",
        window: "five-hour",
        usedPercent: 42,
        resetsAt: new Date(FIVE_HOUR_RESET * 1000).toISOString(),
        hit: false,
        takenAt: TAKEN_AT,
      },
      {
        kind: "window",
        window: "weekly",
        usedPercent: 7,
        resetsAt: new Date(WEEKLY_RESET * 1000).toISOString(),
        hit: false,
        takenAt: TAKEN_AT,
      },
    ]);
  });

  it("reads reset times as epoch seconds", () => {
    const [reading] = buildUsageReadings(
      buildSnapshot({
        primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 1_700_000_000 },
      }),
      TAKEN_AT,
    );
    expect(reading).toMatchObject({ resetsAt: "2023-11-14T22:13:20.000Z" });
  });

  it("reads the monthly window of an account whose primary window is a month", () => {
    const readings = buildUsageReadings(
      buildSnapshot({
        primary: { usedPercent: 10, windowDurationMins: 43_200, resetsAt: null },
      }),
      TAKEN_AT,
    );
    expect(readings).toEqual([
      {
        kind: "window",
        window: "monthly",
        usedPercent: 10,
        resetsAt: null,
        hit: false,
        takenAt: TAKEN_AT,
      },
    ]);
  });

  it("gives readings only for the windows a sparse update carries", () => {
    const readings = buildUsageReadings(
      buildSnapshot({
        limitId: null,
        primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: FIVE_HOUR_RESET },
      }),
      TAKEN_AT,
    );
    expect(readings.map((reading) => reading.kind === "window" && reading.window)).toEqual([
      "five-hour",
    ]);
  });

  it("gives no reading for a snapshot that carries nothing", () => {
    expect(buildUsageReadings(buildSnapshot(), TAKEN_AT)).toEqual([]);
  });

  it("gives no reading for a window with no used percentage, instead of reading it as 0", () => {
    const unreadable = { usedPercent: null, windowDurationMins: 300, resetsAt: null };
    const readings = buildUsageReadings(
      buildSnapshot({ primary: unreadable as unknown as RateLimitSnapshot["primary"] }),
      TAKEN_AT,
    );
    expect(readings).toEqual([]);
  });

  it("drops a window of an unknown or missing length", () => {
    const readings = buildUsageReadings(
      buildSnapshot({
        primary: { usedPercent: 20, windowDurationMins: 60, resetsAt: FIVE_HOUR_RESET },
        secondary: { usedPercent: 30, windowDurationMins: null, resetsAt: WEEKLY_RESET },
      }),
      TAKEN_AT,
    );
    expect(readings).toEqual([]);
  });

  it("clamps the used percentage to 0-100 and marks a full window as hit", () => {
    const readings = buildUsageReadings(
      buildSnapshot({
        primary: { usedPercent: 130, windowDurationMins: 300, resetsAt: FIVE_HOUR_RESET },
        secondary: { usedPercent: 99.5, windowDurationMins: 10_080, resetsAt: WEEKLY_RESET },
      }),
      TAKEN_AT,
    );
    expect(readings).toMatchObject([
      { window: "five-hour", usedPercent: 100, hit: true },
      { window: "weekly", usedPercent: 99.5, hit: false },
    ]);
  });

  it("does not take a window as hit from the snapshot's reached type alone", () => {
    const readings = buildUsageReadings(
      buildSnapshot({
        primary: { usedPercent: 80, windowDurationMins: 300, resetsAt: FIVE_HOUR_RESET },
        rateLimitReachedType: "rate_limit_reached",
      }),
      TAKEN_AT,
    );
    expect(readings).toMatchObject([{ window: "five-hour", hit: false }]);
  });

  it("reads the credit balance of an account with limited credits", () => {
    const readings = buildUsageReadings(
      buildSnapshot({ credits: { hasCredits: true, unlimited: false, balance: "12.5" } }),
      TAKEN_AT,
    );
    expect(readings).toEqual([{ kind: "credit", remaining: 12.5, limit: null, takenAt: TAKEN_AT }]);
  });

  it.each([
    ["unlimited credits", { hasCredits: true, unlimited: true, balance: "100" }],
    ["no credits", { hasCredits: false, unlimited: false, balance: "0" }],
    ["no balance", { hasCredits: true, unlimited: false, balance: null }],
    ["a balance that is not a number", { hasCredits: true, unlimited: false, balance: "n/a" }],
    ["an empty balance", { hasCredits: true, unlimited: false, balance: "" }],
  ])("gives no credit reading for %s", (_name, credits) => {
    expect(buildUsageReadings(buildSnapshot({ credits }), TAKEN_AT)).toEqual([]);
  });
});

describe("which snapshot is the account's Codex limit", () => {
  const OTHER = buildSnapshot({
    limitId: "codex_other",
    primary: { usedPercent: 90, windowDurationMins: 300, resetsAt: null },
  });

  const buildResponse = (
    overrides: Partial<GetAccountRateLimitsResponse>,
  ): GetAccountRateLimitsResponse => ({
    ordinaryUsageAllowed: true,
    rateLimits: PLUS,
    rateLimitsByLimitId: null,
    rateLimitResetCredits: null,
    accountId: null,
    rateLimitUpsell: null,
    ...overrides,
  });

  it("prefers the codex entry of the multi-limit view", () => {
    const named = buildSnapshot({
      primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: null },
    });
    const response = buildResponse({
      rateLimits: OTHER,
      rateLimitsByLimitId: { codex: named, codex_other: OTHER },
    });
    expect(pickCodexSnapshot(response)).toBe(named);
  });

  it("falls back to the single view when it is the codex limit or names no limit", () => {
    expect(pickCodexSnapshot(buildResponse({}))).toBe(PLUS);
    const unnamed = buildSnapshot({ limitId: null });
    expect(pickCodexSnapshot(buildResponse({ rateLimits: unnamed }))).toBe(unnamed);
  });

  it("gives nothing when the single view is another limit and there is no codex entry", () => {
    const response = buildResponse({
      rateLimits: OTHER,
      rateLimitsByLimitId: { codex_other: OTHER },
    });
    expect(pickCodexSnapshot(response)).toBeUndefined();
  });

  it("takes an update for the codex limit or for no named limit, and nothing else", () => {
    expect(pickUpdatedSnapshot({ rateLimits: PLUS })).toBe(PLUS);
    const unnamed = buildSnapshot({ limitId: null });
    expect(pickUpdatedSnapshot({ rateLimits: unnamed })).toBe(unnamed);
    expect(pickUpdatedSnapshot({ rateLimits: OTHER })).toBeUndefined();
  });
});
