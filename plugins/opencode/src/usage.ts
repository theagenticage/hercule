import { Schema } from "effect";
import type { ParseUsageBody, Timestamp, UsageReading } from "@hercule/plugin-host";

/**
 * One window of the usage answer. `status` is a plain string, not a union of
 * the values OpenCode sends today (`ok`, `rate-limited`), so a new status does
 * not fail the whole answer. Every field is optional, so one bad window does
 * not fail the other two.
 */
const UsageWindow = Schema.Struct({
  status: Schema.optionalKey(Schema.String),
  /** The share of the window used, in percent. */
  percent: Schema.optionalKey(Schema.Finite),
  /** When the window resets, as an ISO 8601 string. */
  resetsAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

type UsageWindow = Schema.Schema.Type<typeof UsageWindow>;

/** The answer of OpenCode's Go usage endpoint. A missing window gives no reading. */
const UsageBody = Schema.Struct({
  usage: Schema.Struct({
    rolling: Schema.optionalKey(UsageWindow),
    weekly: Schema.optionalKey(UsageWindow),
    monthly: Schema.optionalKey(UsageWindow),
  }),
});

const decodeUsageBody = Schema.decodeUnknownSync(UsageBody);

/** Converts an ISO 8601 string to a timestamp, or `null` when there is none or it is not a date. */
const convertResetTime = (iso: string | null | undefined): Timestamp | null => {
  if (iso === null || iso === undefined) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/** The name of a usage window, as a reading carries it. */
type WindowName = Extract<UsageReading, { kind: "window" }>["window"];

/**
 * Turns one window of the answer into a reading, stamped with `takenAt`.
 * Returns `undefined` for a window with no `percent`, because a missing number
 * must not show as an empty window.
 */
const readWindow = (
  window: WindowName,
  usage: UsageWindow,
  takenAt: Timestamp,
): UsageReading | undefined => {
  if (usage.percent === undefined) return undefined;
  return {
    kind: "window",
    window,
    usedPercent: Math.min(100, Math.max(0, usage.percent)),
    resetsAt: convertResetTime(usage.resetsAt),
    hit: usage.status === "rate-limited" || usage.percent >= 100,
    takenAt,
  };
};

/**
 * Turns the JSON answer of OpenCode's Go usage endpoint into readings, stamping
 * each with `takenAt`. `rolling` is the five-hour window, then `weekly` and
 * `monthly`. A window that is missing or has no `percent` gives no reading,
 * because a missing number must not show as an empty window.
 *
 * `hit` is true when OpenCode reports `rate-limited`, even below 100 percent,
 * or when the percent is 100 or more.
 *
 * Never returns `{ refused }`: a 401 never reaches it, the usage reader turns
 * it into a refusal. A lapsed subscription answers 403, which is deliberately
 * not a refusal because it says nothing about the key: the read is
 * `unavailable` and the account keeps its last readings.
 *
 * Throws when the answer is not the shape OpenCode's route sends.
 */
export const parseGoUsageBody: ParseUsageBody = (body, takenAt) => {
  const { usage } = decodeUsageBody(body);
  const readings = [
    usage.rolling && readWindow("five-hour", usage.rolling, takenAt),
    usage.weekly && readWindow("weekly", usage.weekly, takenAt),
    usage.monthly && readWindow("monthly", usage.monthly, takenAt),
  ].filter((reading) => reading !== undefined);
  return { readings };
};
