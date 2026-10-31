/**
 * Conversions both harnesses' usage readers share: the vendors report a time
 * in epoch seconds and a share of a window in percent, and the protocol wants
 * a timestamp and a share from 0 to 100.
 */
import type { Timestamp } from "@hercule/protocol";

/**
 * Converts a number of seconds since the epoch to a protocol timestamp.
 * Returns `null` when `seconds` is not a number or not a valid time. The
 * vendors' JSON is not checked against their types, so the type is `unknown`.
 */
export const convertEpochSecondsToTimestamp = (seconds: unknown): Timestamp | null => {
  if (typeof seconds !== "number") return null;
  const at = new Date(seconds * 1000);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
};

/** Limits a share to the 0 to 100 the protocol allows. A vendor can report more than 100. */
export const clampPercent = (percent: number): number => Math.min(100, Math.max(0, percent));
