/**
 * Turns the rate limits Codex reports into Account Usage readings (spec 06
 * section 18). Codex reports them two ways: the reply to
 * `account/rateLimits/read`, and the `account/rateLimits/updated`
 * notification during a turn. Both carry a `RateLimitSnapshot`.
 */
import type { Timestamp, UsageReading, UsageWindow } from "@hercule/protocol";
import type {
  AccountRateLimitsUpdatedNotification,
  GetAccountRateLimitsResponse,
  RateLimitSnapshot,
  RateLimitWindow,
} from "./types";

/** The limit that covers ordinary Codex use. Codex also reports limits for single models, which are not read. */
const CODEX_LIMIT_ID = "codex";

/** The length of each window Hercule names, in minutes. Any other length is not read. */
const WINDOW_BY_DURATION_MINUTES: ReadonlyMap<number, UsageWindow["window"]> = new Map([
  [300, "five-hour"],
  [10_080, "weekly"],
  [43_200, "monthly"],
]);

/**
 * Returns the snapshot of the `codex` limit in the reply to
 * `account/rateLimits/read`, or `undefined` when the reply has none.
 *
 * - `rateLimitsByLimitId.codex` is used when present.
 * - Otherwise `rateLimits` (the single-snapshot view) is used when its
 *   `limitId` is `codex` or `null`. A snapshot that names another limit is
 *   not the account's ordinary usage.
 */
export const pickCodexSnapshot = (
  response: GetAccountRateLimitsResponse,
): RateLimitSnapshot | undefined => {
  const named = response.rateLimitsByLimitId?.[CODEX_LIMIT_ID];
  if (named !== undefined) return named;
  return isCodexLimit(response.rateLimits) ? response.rateLimits : undefined;
};

/**
 * Returns the snapshot of an `account/rateLimits/updated` notification, or
 * `undefined` when it is for another limit. A rolling update may leave out
 * account metadata, so a `limitId` of `null` counts as the `codex` limit,
 * as it does in the single-snapshot view of a read.
 */
export const pickUpdatedSnapshot = (
  params: AccountRateLimitsUpdatedNotification,
): RateLimitSnapshot | undefined =>
  isCodexLimit(params.rateLimits) ? params.rateLimits : undefined;

const isCodexLimit = (
  snapshot: RateLimitSnapshot | null | undefined,
): snapshot is RateLimitSnapshot =>
  snapshot !== null &&
  snapshot !== undefined &&
  (snapshot.limitId === CODEX_LIMIT_ID || snapshot.limitId === null);

/**
 * Builds the readings a snapshot holds, taken at `takenAt`. A field that is
 * missing or null gives no reading: an update may carry only some windows,
 * and a value Hercule did not receive is never filled in.
 *
 * - A window is read when its length is 300, 10080 or 43200 minutes. A window
 *   of another length, or of unknown length, is left out.
 * - `usedPercent` is clamped to 0-100.
 * - `hit` is true when `usedPercent` is 100 or more. The snapshot's
 *   `rateLimitReachedType` is not used: it does not say which window was
 *   reached, and its credit values describe credit, not a window.
 * - Credit is read when the account has credits that are not unlimited and
 *   the balance is a number.
 */
export const buildUsageReadings = (
  snapshot: RateLimitSnapshot,
  takenAt: Timestamp,
): ReadonlyArray<UsageReading> => {
  const readings: Array<UsageReading> = [];
  for (const window of [snapshot.primary, snapshot.secondary]) {
    const reading = buildWindowReading(window, takenAt);
    if (reading !== undefined) readings.push(reading);
  }
  const credit = buildCreditReading(snapshot, takenAt);
  if (credit !== undefined) readings.push(credit);
  return readings;
};

const buildWindowReading = (
  window: RateLimitWindow | null | undefined,
  takenAt: Timestamp,
): UsageWindow | undefined => {
  if (window === null || window === undefined) return undefined;
  const name = WINDOW_BY_DURATION_MINUTES.get(window.windowDurationMins ?? Number.NaN);
  // The app-server's JSON is not checked against the types, and the protocol
  // refuses a percentage that is not a number.
  if (name === undefined || typeof window.usedPercent !== "number") return undefined;
  if (!Number.isFinite(window.usedPercent)) return undefined;
  const usedPercent = Math.min(100, Math.max(0, window.usedPercent));
  return {
    kind: "window",
    window: name,
    usedPercent,
    resetsAt: readResetTime(window.resetsAt),
    hit: usedPercent >= 100,
    takenAt,
  };
};

/** Converts Codex's reset time, in epoch seconds, to a timestamp. Returns `null` when there is none or it is not a valid time. */
const readResetTime = (epochSeconds: number | null | undefined): Timestamp | null => {
  if (typeof epochSeconds !== "number") return null;
  const date = new Date(epochSeconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const buildCreditReading = (
  { credits }: RateLimitSnapshot,
  takenAt: Timestamp,
): UsageReading | undefined => {
  if (credits === null || credits === undefined) return undefined;
  if (!credits.hasCredits || credits.unlimited) return undefined;
  const balance = typeof credits.balance === "string" ? credits.balance.trim() : "";
  const remaining = balance === "" ? Number.NaN : Number(balance);
  if (!Number.isFinite(remaining) || remaining < 0) return undefined;
  return { kind: "credit", remaining, limit: null, takenAt };
};
