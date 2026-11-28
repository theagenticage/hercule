/**
 * What the Providers page draws for a Provider Account's Account Usage (spec 06
 * section 18, spec 17 §Settings, Providers): the card's gauge and the account
 * sheet's Usage section both read this, so they cannot disagree.
 */
import type { AccountUsageReading, ProviderAccount } from "@hercule/contract";
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
  /** What the line means, for its tooltip, such as "85% used, 5-hour window, resets Fri 14:00". */
  readonly tooltip: string;
}

/** The credit an account has left, ready to draw as a number. It has no bar: a credit is not a share of a window. */
export interface AccountUsageCreditLine {
  readonly kind: "credit";
  readonly label: "Credits";
  /** The number left, such as "1,240", or "1.2M" for a large one. The wire does not name the unit. */
  readonly remainingText: string;
  /** What follows the number: "of 2,000 credits left", or "credits left" when the provider reports no limit. */
  readonly suffixText: string;
  /** The whole line, such as "1,240 of 2,000 credits left": the number, then what follows it. */
  readonly text: string;
}

export type AccountUsageLine = AccountUsageWindowLine | AccountUsageCreditLine;

/** What a gauge shows for an account that has usage readings. */
export interface AccountUsageGauge {
  /** One line for each reading, in the order the account lists them: five-hour, weekly, monthly, then the credit. */
  readonly lines: ReadonlyArray<AccountUsageLine>;
  /** When the newest reading was taken, such as "10:42", or `null` when it cannot be formatted. */
  readonly asOf: string | null;
}

/** The number of credits from which a count is written short, such as "1.2M". */
const COMPACT_FROM = 1e6;

/** The number of credits from which a count is written in scientific notation, such as "1.8E308". */
const SCIENTIFIC_FROM = 1e15;

const PLAIN_COUNT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const COMPACT_COUNT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const SCIENTIFIC_COUNT = new Intl.NumberFormat("en-US", {
  notation: "scientific",
  maximumFractionDigits: 1,
});

/**
 * Returns a count of credits as the gauge writes it: "1,240.5" below a
 * million, "1.2M" up to a quadrillion, and "1.8E308" above, so that a wild
 * number from the reporter cannot widen the card.
 */
const formatCount = (value: number): string => {
  const size = Math.abs(value);
  if (size >= SCIENTIFIC_FROM) return SCIENTIFIC_COUNT.format(value);
  return (size >= COMPACT_FROM ? COMPACT_COUNT : PLAIN_COUNT).format(value);
};

/**
 * Returns the line of a credit reading. The caller has checked the reading is
 * worth a line (see `isWorthDrawing`).
 */
const describeCreditLine = (
  reading: Extract<AccountUsageReading, { kind: "credit" }>,
): AccountUsageCreditLine => {
  const remainingText = formatCount(reading.remaining);
  const suffixText =
    reading.limit === null ? "credits left" : `of ${formatCount(reading.limit)} credits left`;
  return {
    kind: "credit",
    label: "Credits",
    remainingText,
    suffixText,
    text: `${remainingText} ${suffixText}`,
  };
};

/**
 * Returns whether a reading earns a line. A credit of zero with no limit does
 * not: most ChatGPT users never bought credits, and "0 credits left" on every
 * card would be noise. With a limit, zero is a real state and shows.
 */
const isWorthDrawing = (reading: AccountUsageReading): boolean =>
  !(reading.kind === "credit" && reading.remaining === 0 && reading.limit === null);

/**
 * Returns what a gauge draws for the account's usage readings, with times in
 * `timezone` relative to `now`, or `null` when no reading earns a line.
 * Nothing is estimated: an account whose provider reports no usage has no
 * gauge. `asOf` is the time of the newest reading that has a line.
 */
export const describeAccountUsage = (
  account: Pick<ProviderAccount, "usage">,
  timezone: string,
  now: Date,
): AccountUsageGauge | null => {
  const readings = account.usage.filter(isWorthDrawing);
  if (readings.length === 0) return null;
  const lines = readings.map((reading): AccountUsageLine => {
    if (reading.kind === "credit") return describeCreditLine(reading);
    const percent = Math.round(reading.usedPercent);
    const resets =
      reading.resetsAt === null
        ? undefined
        : formatShortMoment(new Date(reading.resetsAt), now, timezone);
    const label = WINDOW_LABELS[reading.window];
    const share = reading.hit ? "Limit reached" : `${String(percent)}% used`;
    return {
      kind: "window",
      label,
      valueText: reading.hit ? "Hit" : `${String(percent)}%`,
      fillPercent: reading.hit ? 100 : percent,
      tone: reading.hit ? "fail" : percent >= HOT_PERCENT ? "attention" : "normal",
      resetsText: resets === undefined ? null : `resets ${resets}`,
      tooltip:
        resets === undefined
          ? `${share}, ${label} window`
          : `${share}, ${label} window, resets ${resets}`,
    };
  });
  const newest = Math.max(...readings.map((reading) => Date.parse(reading.takenAt)));
  return {
    lines,
    asOf: formatMessageTime(new Date(newest), timezone, now) ?? null,
  };
};
