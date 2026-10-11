/**
 * The times of the workflow screens, such as a last run's "10:31" or when a
 * step started, "Today 09:12", kept current by the age clock. It is a module
 * of its own, imported only by the workflow screens, so its code and
 * `@hercule/client-core/list-time` load in the workflow routes' chunks and
 * stay off the first screen.
 */
import { useCallback } from "react";
import {
  findNextListTimeChange,
  formatListTime,
  formatStartTime,
} from "@hercule/client-core/list-time";
import { useClockValue } from "../../app/age-clock";

/**
 * Returns the moment `at`, an ISO instant, as a list shows it in `timezone`
 * (`formatListTime`): "10:31" today, "Sun" within six days, then "1 Oct".
 * `direction` says whether the moment is past, such as a last run, or to
 * come, such as a next fire. Keeps the text current while `onScreen` is
 * true, so "10:31" becomes "Sun" once its day has passed. Returns an empty
 * text for a moment `formatListTime` cannot place.
 */
export const useListTime = (
  at: string,
  timezone: string,
  direction: "past" | "future",
  onScreen: boolean,
): string => {
  const findNextChange = useCallback(
    (moment: string, now: Date) =>
      findNextListTimeChange(new Date(moment), timezone, now, direction),
    [timezone, direction],
  );
  return useClockValue(
    at,
    onScreen,
    findNextChange,
    (now) => formatListTime(new Date(at), timezone, now, direction) ?? "",
  );
};

/**
 * Returns when a run or a step started, `at`, an ISO instant, with its day
 * and clock time in `timezone` (`formatStartTime`): "Today 09:12", "Fri
 * 14:00", then "25 Sep 14:00". Keeps the text current, so "Today" becomes
 * the weekday at midnight. Returns an empty text for a moment
 * `formatStartTime` cannot place.
 */
export const useStartTime = (at: string, timezone: string): string => {
  const findNextChange = useCallback(
    (moment: string, now: Date) => findNextListTimeChange(new Date(moment), timezone, now, "past"),
    [timezone],
  );
  return useClockValue(
    at,
    true,
    findNextChange,
    (now) => formatStartTime(new Date(at), timezone, now) ?? "",
  );
};
