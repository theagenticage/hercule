/**
 * The Done signals that count what was cleared today, which the foot under
 * To do and inbox zero both show (spec 17 §Intake).
 */
import { useEffect } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { Signal } from "@hercule/contract";
import { computeNextMidnight, reachesBeforeToday } from "@hercule/client-core";
import { ageClock, useZonedClockValue } from "../../app/age-clock";
import { signalsClearedTodayQuery } from "../../app/queries";

/**
 * Returns the next midnight after `now` in `timezone`. A zone that cannot be
 * read has no midnight, so an hour later is returned instead.
 */
const findNextMidnight = (timezone: string, now: Date): Date =>
  computeNextMidnight(now, timezone) ?? new Date(now.getTime() + 3_600_000);

/**
 * Returns the Done signals read so far, newest first, and the age clock's
 * time to count them at with `countClearedToday`, where "today" starts at
 * midnight in `timezone`, the user's timezone setting.
 *
 * It reads Done page by page until a page reaches a signal resolved before
 * today, so a busy day is counted whole. The calling component draws again
 * when midnight passes, so "today" follows the date.
 */
export function useSignalsClearedToday(timezone: string): {
  readonly signals: ReadonlyArray<Signal>;
  readonly now: Date;
} {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const done = useInfiniteQuery(signalsClearedTodayQuery(client));
  const signals = done.data?.pages.flatMap((page) => page.items) ?? [];
  // The value is the start of the next day, which changes only at midnight,
  // so a clock read during the day draws nothing again.
  useZonedClockValue(timezone, findNextMidnight, (now) =>
    findNextMidnight(timezone, now).getTime(),
  );
  const now = ageClock.readNow();
  const complete = reachesBeforeToday(signals, now, timezone);
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = done;

  // A page that failed is not asked for again here: the effect would retry
  // it at once, over and over. The next push reads the pages again.
  useEffect(() => {
    if (!complete && hasNextPage && !isFetchingNextPage && !isFetchNextPageError) {
      void fetchNextPage();
    }
  }, [complete, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage]);

  return { signals, now };
}
