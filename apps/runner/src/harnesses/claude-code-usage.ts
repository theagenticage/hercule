/**
 * Turns what Claude Code says about the usage of a claude.ai subscription into
 * `UsageReading`s. Two sources feed it, and both are pure here:
 *
 * - the `rate_limit_event` messages of a running session;
 * - the answer to the SDK's usage read, which a probe asks for.
 *
 * Only the two account-wide windows are mapped: the five hours and the week.
 * The per-model windows (Opus, Sonnet) and the overage window are dropped.
 */
import type { SDKControlGetUsageResponse, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type { UsageReading } from "@hercule/protocol";

/** The part of the SDK's usage answer the probe reads. */
export type ClaudeUsageAnswer = Pick<
  SDKControlGetUsageResponse,
  "rate_limits_available" | "rate_limits"
>;

/** The usage window of a reading, by the name Claude gives the window. */
type UsageWindowName = Extract<UsageReading, { kind: "window" }>["window"];

/** Returns the window Claude's name stands for, or `undefined` for a window this runner does not map. */
const findWindow = (rateLimitType: string | undefined): UsageWindowName | undefined => {
  switch (rateLimitType) {
    case "five_hour":
      return "five-hour";
    case "seven_day":
      return "weekly";
    default:
      return undefined;
  }
};

/** Converts a number of seconds since the epoch to a protocol timestamp, or `null` if it is not a time. */
const convertSecondsToTimestamp = (seconds: unknown): string | null => {
  if (typeof seconds !== "number") return null;
  const at = new Date(seconds * 1000);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
};

/** Converts an ISO-8601 text to a protocol timestamp, or `null` if it is not a time. */
const convertTextToTimestamp = (text: unknown): string | null => {
  if (typeof text !== "string") return null;
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
};

/** Limits a share to the 0 to 100 the protocol allows. Claude can report more than 100. */
const clampPercent = (percent: number): number => Math.min(100, Math.max(0, percent));

/**
 * Builds the readings of one `rate_limit_event`: one reading for a five-hour
 * or weekly window that carries a utilization, and none otherwise. Never
 * invents a value: an event with no utilization (Claude leaves it out below
 * its warning threshold) gives no reading, not 0 percent.
 *
 * `utilization` is a fraction here (1 is the full window, and it can go
 * above 1). `resetsAt` is in epoch seconds. The window is `hit` when Claude
 * rejects the request. `takenAt` is the time the runner read the event.
 */
export const buildRateLimitReadings = (
  info: Pick<SDKRateLimitInfo, "status" | "rateLimitType" | "resetsAt" | "utilization">,
  takenAt: string,
): ReadonlyArray<UsageReading> => {
  const window = findWindow(info.rateLimitType);
  const utilization = info.utilization;
  if (window === undefined || typeof utilization !== "number" || !Number.isFinite(utilization)) {
    return [];
  }
  return [
    {
      kind: "window",
      window,
      usedPercent: clampPercent(utilization * 100),
      resetsAt: convertSecondsToTimestamp(info.resetsAt),
      hit: info.status === "rejected",
      takenAt,
    },
  ];
};

/**
 * Builds the readings of the SDK's usage answer. Returns `null` when plan
 * limits do not apply to the account (an API key, Bedrock, Vertex): the
 * harness then has no usage to give. Returns the readings of the five-hour
 * and weekly windows that carry a utilization, which can be none.
 *
 * `utilization` is a percentage here (0 to 100), unlike in a
 * `rate_limit_event`. The window is `hit` at 100 percent or more.
 */
export const buildUsageAnswerReadings = (
  answer: ClaudeUsageAnswer,
  takenAt: string,
): ReadonlyArray<UsageReading> | null => {
  const limits = answer.rate_limits;
  if (!answer.rate_limits_available || limits === null || limits === undefined) return null;
  const readings: Array<UsageReading> = [];
  const windows = [
    ["five-hour", limits.five_hour],
    ["weekly", limits.seven_day],
  ] as const;
  for (const [window, reported] of windows) {
    const utilization = reported?.utilization;
    if (typeof utilization !== "number" || !Number.isFinite(utilization)) continue;
    readings.push({
      kind: "window",
      window,
      usedPercent: clampPercent(utilization),
      resetsAt: convertTextToTimestamp(reported?.resets_at),
      hit: utilization >= 100,
      takenAt,
    });
  }
  return readings;
};
