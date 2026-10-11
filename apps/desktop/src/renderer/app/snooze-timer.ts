/**
 * The snooze timer: brings a snoozed signal back to To do when its snooze
 * runs out, while the app runs, whichever screen shows.
 *
 * The controller sends no push when a snooze runs out, because nothing is
 * written then: the signal simply belongs to To do from that moment. So the
 * app keeps one timer for the soonest `until` on Later, and reads To do and
 * Later again when it fires (spec 17 §Intake). Later is read soonest first,
 * so its first page, which the shell loads, holds that `until`. After the
 * reads, the timer is set for the next soonest `until`. With nothing
 * snoozed there is no timer.
 *
 * Unlike the age clock, the timer also runs while the window is hidden: a
 * signal coming back may be a Now signal, whose notification must show. A
 * timer may not count the time the Mac slept, so the lists are also read
 * again when the window is shown or gets focus and a snooze has run out.
 */
import { useEffect } from "react";
import { useSuspenseInfiniteQuery, type QueryClient } from "@tanstack/react-query";
import { invalidateWithoutCancelling, queryKeys, type HerculeClient } from "@hercule/client-core";
import { signalsLaterQuery } from "./queries";

/**
 * The longest delay `setTimeout` keeps. A longer one runs after 1 ms
 * instead. When a timer this long fires, nothing has run out yet, the reads
 * return the same `until`, and the timer is set again.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * How long after `until` the timer fires. The controller decides with its
 * own clock whether a snooze has run out, and this Mac's clock may run a
 * little ahead of it. Firing a second late gives the controller's clock
 * time to pass `until` too. If it has not, the signal is still on Later
 * with an `until` in the past, and the timer fires again a second later.
 */
const CONTROLLER_CLOCK_MARGIN_MS = 1_000;

/**
 * Keeps the snooze timer running while the calling component is mounted.
 * Call it once, in the shell, whose loader has loaded Later's first page.
 */
export const useSnoozeTimer = (client: HerculeClient, queryClient: QueryClient): void => {
  const { data, dataUpdatedAt } = useSuspenseInfiniteQuery(signalsLaterQuery(client));
  const until = data.pages[0]?.items[0]?.snooze?.until;

  useEffect(() => {
    if (until === undefined) return;
    const runsOutAt = Date.parse(until);
    // To do and Later are both under the `signals` key, as is Done, which
    // only reads again if it is on screen.
    const readListsAgain = (): void => {
      invalidateWithoutCancelling(queryClient, queryKeys.signals());
    };
    const timer = setTimeout(
      readListsAgain,
      Math.min(
        MAX_TIMER_DELAY_MS,
        Math.max(0, runsOutAt - Date.now()) + CONTROLLER_CLOCK_MARGIN_MS,
      ),
    );
    const readIfRunOut = (): void => {
      if (document.visibilityState === "visible" && Date.now() >= runsOutAt) readListsAgain();
    };
    document.addEventListener("visibilitychange", readIfRunOut);
    window.addEventListener("focus", readIfRunOut);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", readIfRunOut);
      window.removeEventListener("focus", readIfRunOut);
    };
    // `dataUpdatedAt` sets the timer again after every read, so a read that
    // returns the same `until`, still in the past, tries again.
  }, [client, queryClient, until, dataUpdatedAt]);
};
