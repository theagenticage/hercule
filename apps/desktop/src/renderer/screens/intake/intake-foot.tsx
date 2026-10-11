/**
 * The foot under Intake's To do list: how many signals were cleared today
 * (spec 17 §The foot, the toast and failures).
 */
import { useCallback, useEffect, useSyncExternalStore, type JSX } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import {
  computeNextMidnight,
  countClearedToday,
  describeIntakeFoot,
  reachesBeforeToday,
} from "@hercule/client-core";
import { ageClock } from "../../app/age-clock";
import { signalsClearedTodayQuery } from "../../app/queries";

/**
 * Draws the calling component again when the age clock's time passes
 * midnight in `timezone`, so "today" follows the date. The clock reads the
 * time again when the window is shown or gets focus, which covers a Mac that
 * slept past midnight.
 */
const useRedrawAtMidnight = (timezone: string): void => {
  const subscribe = useCallback(
    (onChange: () => void) =>
      ageClock.watch(
        // A zone that cannot be read has no midnight; an hour later is checked instead.
        (now) => computeNextMidnight(now, timezone) ?? new Date(now.getTime() + 3_600_000),
        onChange,
      ),
    [timezone],
  );
  // The value is the start of the next day, which changes only at midnight,
  // so a clock read during the day draws nothing again.
  useSyncExternalStore(
    subscribe,
    () => computeNextMidnight(ageClock.readNow(), timezone)?.getTime() ?? 0,
  );
};

/**
 * Renders the foot: "7 cleared today. See Done.", counted in `timezone`,
 * the user's timezone setting. "See Done" links to the Done view. With
 * nothing cleared today there is no foot.
 *
 * The count reads Done newest first, page by page, until a page reaches a
 * signal resolved before today, so a busy day is counted whole.
 */
export function IntakeFoot({ timezone }: { readonly timezone: string }): JSX.Element | null {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const done = useInfiniteQuery(signalsClearedTodayQuery(client));
  const signals = done.data?.pages.flatMap((page) => page.items) ?? [];
  useRedrawAtMidnight(timezone);
  const now = ageClock.readNow();
  const complete = reachesBeforeToday(signals, now, timezone);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = done;

  useEffect(() => {
    if (!complete && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [complete, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const line = describeIntakeFoot(countClearedToday(signals, now, timezone));
  if (line === null) return null;
  return (
    <p className="asks-cleared">
      {line}{" "}
      <Link to="/intake" search={{ view: "done" }} className="asks-cleared-link">
        See Done
      </Link>
      .
    </p>
  );
}
