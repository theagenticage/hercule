/**
 * What the Providers page draws for a Provider Account's Account Usage (spec 06
 * section 18, spec 17 §Settings, Providers): the card's gauge and the account
 * sheet's Usage section both read this, so they cannot disagree.
 */
import type { ProviderAccount } from "@hercule/contract";
import { formatShortMoment } from "./time-context";
import { formatMessageTime } from "./threads/message-time";

/** The share of a window from which the gauge turns to the attention hue. */
const HOT_PERCENT = 80;

const WINDOW_LABELS = {
  "five-hour": "5-hour",
  weekly: "Weekly",
  monthly: "Monthly",
} as const;

/**
 * How a gauge colours a line:
 *
 * - `normal`: the ink colour;
 * - `attention`: the window is 80% used or more;
 * - `fail`: the window's limit is reached, so the account cannot run until it resets.
 */
export type AccountUsageTone = "normal" | "attention" | "fail";

/** One usage window, ready to draw as a bar. */
export interface AccountUsageWindowLine {
  readonly kind: "window";
  readonly label: string;
  /** The number beside the bar, such as "85%", or "Hit" for a window whose limit is reached. */
  readonly valueText: string;
  /** How much of the bar is filled, from 0 to 100. A window that is hit fills the bar. */
  readonly fillPercent: number;
  readonly tone: AccountUsageTone;
  /** When the window resets, such as "resets Fri 14:00", or `null` when the reporter gave no time. */
  readonly resetsText: string | null;
}

/** The credit an account has left, ready to draw as a number. It has no bar: a credit is not a share of a window. */
export interface AccountUsageCreditLine {
  readonly kind: "credit";
  readonly label: "Credits";
  /** What is left, such as "1,240". The wire does not name the unit. */
  readonly remainingText: string;
  /** What the credit started at, such as "of 2,000", or `null` when the provider reports no limit. */
  readonly limitText: string | null;
}

export type AccountUsageLine = AccountUsageWindowLine | AccountUsageCreditLine;

/** What a gauge shows for an account that has usage readings. */
export interface AccountUsage {
  /** One line for each reading, in the order the account lists them: five-hour, weekly, monthly, then the credit. */
  readonly lines: ReadonlyArray<AccountUsageLine>;
  /** When the newest reading was taken, such as "10:42", or `null` when it cannot be formatted. */
  readonly asOf: string | null;
}

const formatCount = (value: number): string =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);

/**
 * Returns what a gauge draws for the account's usage readings, with times in
 * `timezone` relative to `now`, or `null` when the account has no reading.
 * Nothing is estimated: an account whose provider reports no usage has no
 * gauge. `asOf` is the time of the newest reading.
 */
export const describeAccountUsage = (
  account: Pick<ProviderAccount, "usage">,
  timezone: string,
  now: Date,
): AccountUsage | null => {
  if (account.usage.length === 0) return null;
  const lines = account.usage.map((reading): AccountUsageLine => {
    if (reading.kind === "credit") {
      return {
        kind: "credit",
        label: "Credits",
        remainingText: formatCount(reading.remaining),
        limitText: reading.limit === null ? null : `of ${formatCount(reading.limit)}`,
      };
    }
    const percent = Math.round(reading.usedPercent);
    const resets =
      reading.resetsAt === null
        ? undefined
        : formatShortMoment(new Date(reading.resetsAt), now, timezone);
    return {
      kind: "window",
      label: WINDOW_LABELS[reading.window],
      valueText: reading.hit ? "Hit" : `${percent}%`,
      fillPercent: reading.hit ? 100 : percent,
      tone: reading.hit ? "fail" : percent >= HOT_PERCENT ? "attention" : "normal",
      resetsText: resets === undefined ? null : `resets ${resets}`,
    };
  });
  const newest = Math.max(...account.usage.map((reading) => Date.parse(reading.takenAt)));
  return {
    lines,
    asOf: formatMessageTime(new Date(newest), timezone, now) ?? null,
  };
};
