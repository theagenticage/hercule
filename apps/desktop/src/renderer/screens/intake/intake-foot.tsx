/**
 * The foot under Intake's To do list: how many signals were cleared today
 * (spec 17 §The foot, the toast and failures).
 */
import { useEffect, type JSX } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import { countClearedToday, describeIntakeFoot, reachesBeforeToday } from "@hercule/client-core";
import { signalsDoneQuery } from "../../app/queries";

/** The end of the foot's line, drawn as a link to the Done view. */
const SEE_DONE = "See Done.";

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
  const done = useInfiniteQuery(signalsDoneQuery(client));
  const signals = done.data?.pages.flatMap((page) => page.items) ?? [];
  const now = new Date();
  const complete = reachesBeforeToday(signals, now, timezone);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = done;

  useEffect(() => {
    if (!complete && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [complete, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const line = describeIntakeFoot(countClearedToday(signals, now, timezone));
  if (line === null) return null;
  return (
    <p className="asks-cleared">
      {/* The line always ends in "See Done.", which is drawn as the link. */}
      {line.slice(0, -SEE_DONE.length)}
      <Link to="/intake" search={{ view: "done" }} className="asks-cleared-link">
        See Done
      </Link>
      .
    </p>
  );
}
