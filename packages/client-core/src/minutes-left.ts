/**
 * The minutes a one-time code has left, as a screen counts them down: a
 * provider's device login and GitHub's device flow both hand out a code that
 * expires.
 */

const MINUTE_MS = 60_000;

/**
 * Returns how many whole minutes a code that expires at `expiresAt` still
 * works at `now`, in milliseconds since the epoch. The count is rounded up,
 * so it is at least 1 while the code works, and 0 once it has expired.
 */
export const countMinutesLeft = (expiresAt: string, now: number): number =>
  Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / MINUTE_MS));

/** Returns `minutes` as words, such as "1 minute" or "12 minutes". */
export const describeMinutes = (minutes: number): string =>
  `${String(minutes)} ${minutes === 1 ? "minute" : "minutes"}`;

/**
 * Returns the sentence about how long a code still works, given its
 * `countMinutesLeft`: "The code expires in 12 minutes.", or "The code has
 * expired." at 0.
 */
export const describeCodeExpiry = (minutesLeft: number): string =>
  minutesLeft === 0
    ? "The code has expired."
    : `The code expires in ${describeMinutes(minutesLeft)}.`;

/**
 * Returns the moment, in milliseconds since the epoch, at which
 * `countMinutesLeft(expiresAt, ...)` next changes after `now`, or null once
 * the code has expired and the count stays 0.
 *
 * The count changes at whole minutes before the expiry, not at the clock's
 * minute, so the moment is counted back from the expiry. The last change is
 * the expiry itself.
 */
export const computeNextMinuteTick = (expiresAt: string, now: number): number | null => {
  const left = Date.parse(expiresAt) - now;
  if (left <= 0) return null;
  return now + (left % MINUTE_MS || MINUTE_MS);
};
