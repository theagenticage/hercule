import { Schema } from "effect";
import type { ParseUsageBody, Timestamp, UsageReading } from "@hercule/plugin-host";

/**
 * One window of the usage answer. `status` is a plain string, not the two
 * values OpenCode sends today (`ok` and `rate-limited`), so a status added
 * later does not fail the whole answer. Only `rate-limited` is read.
 */
const UsageWindow = Schema.Struct({
  status: Schema.String,
  /** The share of the window used, in percent. */
  percent: Schema.Finite,
  /** When the window resets, as an ISO 8601 string. */
  resetsAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

type UsageWindow = Schema.Schema.Type<typeof UsageWindow>;

/**
 * The answer of OpenCode's Go usage endpoint. The three windows are all
 * optional here: a window that is missing gives no reading, and the other two
 * are still read.
 */
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

/** Turns one window of the answer into a reading, stamped with `takenAt`. */
const readWindow = (window: WindowName, usage: UsageWindow, takenAt: Timestamp): UsageReading => ({
  kind: "window",
  window,
  usedPercent: Math.min(100, Math.max(0, usage.percent)),
  resetsAt: convertResetTime(usage.resetsAt),
  hit: usage.status === "rate-limited" || usage.percent >= 100,
  takenAt,
});

/**
 * Turns the JSON answer of OpenCode's Go usage endpoint
 * (`GET https://opencode.ai/zen/go/v1/usage`) into readings, stamping each
 * with `takenAt`.
 *
 * - `rolling` is the five-hour window, `weekly` the weekly one and `monthly`
 *   the monthly one, in that order.
 * - A window that is missing gives no reading, because a missing number must
 *   not show as an empty window.
 * - `usedPercent` is `percent` limited to 0-100. `hit` is true when OpenCode
 *   says the window is `rate-limited`, even below 100 percent, or when the
 *   percent is 100 or more. `resetsAt` is the ISO string normalized, or `null`
 *   when OpenCode sent none or it is not a date.
 *
 * It never returns `{ refused }`, and refusals do not reach it: they are not
 * 2xx answers. OpenCode answers a key it does not know with HTTP 401, which
 * the usage reader turns into a refusal with OpenCode's own `error.message`.
 * A key without an OpenCode Go subscription gets HTTP 403 with
 * `EntitlementError` "OpenCode Go subscription required.". The key check uses
 * this same endpoint and reads a 403 as a refused key, so such a key is turned
 * away when it is entered. A subscription that lapses later also gives 403, and
 * the usage reader does not read that as a refusal, because it says nothing
 * about the key being wrong: the account then shows no gauge.
 *
 * Throws when the answer is not the shape OpenCode's route sends. The caller
 * logs that and leaves the account as it is.
 */
export const parseGoUsageBody: ParseUsageBody = (body, takenAt) => {
  const { usage } = decodeUsageBody(body);
  const readings: Array<UsageReading> = [];
  if (usage.rolling !== undefined) readings.push(readWindow("five-hour", usage.rolling, takenAt));
  if (usage.weekly !== undefined) readings.push(readWindow("weekly", usage.weekly, takenAt));
  if (usage.monthly !== undefined) readings.push(readWindow("monthly", usage.monthly, takenAt));
  return { readings };
};
