/**
 * A time of day as the contract stores it: `HH:MM` on a 24-hour clock, such
 * as a rotation's `dailyAt` or the hours of a heartbeat window.
 */
import { TimeOfDay } from "@hercule/contract";
import * as Schema from "effect/Schema";

// A plain boolean rather than a type guard: the contract's TimeOfDay is a
// string, so a guard would narrow refused text to `never`.
const isTimeOfDay: (text: string) => boolean = Schema.is(TimeOfDay);

/**
 * Parses `HH:MM` on a 24-hour clock, such as "07:30", into its hour and
 * minute. Returns `null` for any text the contract refuses, such as "7:30"
 * or "24:00".
 */
export const parseTimeOfDay = (
  text: string,
): { readonly hour: number; readonly minute: number } | null =>
  isTimeOfDay(text) ? { hour: Number(text.slice(0, 2)), minute: Number(text.slice(3)) } : null;

/**
 * Returns the error a time field shows for `text`, or `null` when `text` is
 * a time of day the contract accepts.
 */
export const findTimeOfDayError = (text: string): string | null =>
  isTimeOfDay(text)
    ? null
    : `"${text}" is not a time. Write it as HH:MM on a 24-hour clock, such as 07:00.`;

/** Formats an hour and a minute as `HH:MM`, such as "07:00". */
export const formatTimeOfDay = (hour: number, minute: number): string =>
  `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
