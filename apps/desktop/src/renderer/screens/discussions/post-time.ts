/**
 * The times of an open Discussion: when a Post was written and when a file
 * was shared, kept current by the age clock. It is imported only by the
 * Discussions screen, so its code loads in that route's chunk.
 */
import { useCallback } from "react";
import { formatMessageTime } from "@hercule/client-core";
import { findNextListTimeChange } from "@hercule/client-core/list-time";
import { useClockValue } from "../../app/age-clock";

/**
 * Returns the moment `at`, an ISO instant, as the transcript shows a
 * message's time in `timezone` (`formatMessageTime`): "09:14" today, and
 * "4 Sep 09:04" on another day. Keeps the text current, so "09:14" gains its
 * date at midnight, with no timer of its own: the age clock holds the one
 * timer for every label on screen. Returns an empty text for a moment
 * `formatMessageTime` cannot place.
 */
export const usePostTime = (at: string, timezone: string): string => {
  // Both texts change only when the local date does.
  const findNextChange = useCallback(
    (moment: string, now: Date) => findNextListTimeChange(new Date(moment), timezone, now, "past"),
    [timezone],
  );
  return useClockValue(
    at,
    true,
    findNextChange,
    (now) => formatMessageTime(new Date(at), timezone, now) ?? "",
  );
};
