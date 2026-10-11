/**
 * The snooze timer: brings a snoozed signal back to To do when its snooze
 * runs out, while the app runs, whichever screen shows.
 *
 * The controller sends no push when a snooze runs out, because nothing is
 * written then: the signal simply belongs to To do from that moment. So the
 * app keeps one timer for the soonest `until` on Later, which the shell
 * reads as one signal (`snoozeTimerQuery`). With nothing snoozed there is no
 * timer.
 *
 * When the timer fires, it reads the soonest `until` again. Once that read
 * returns a different `until`, the snooze has left Later, and the timer
 * reads To do and every other signal list again (spec 17 §Intake). The
 * lists are read after the `until` read, never before it, so To do cannot
 * be read a moment before the controller moves the signal and then stay
 * out of date.
 *
 * The controller decides with its own clock, which may run behind this
 * Mac's. While the `until` read still returns the `until` that ran out, the
 * timer reads it again after 1 s, then 2 s, 4 s and so on, up to once a
 * minute. One timer runs at a time.
 *
 * The timer also runs while the window is hidden: a signal coming back may
 * be a Now signal, whose notification must show. A timer may not count the
 * time the Mac slept, so the `until` is also read again when the window is
 * shown or gets focus after it ran out. When the Mac wakes, the live
 * connection reconnects, and its first push reads every signal list again,
 * the `until` read included.
 */
import { useEffect } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { invalidateWithoutCancelling, queryKeys, type HerculeClient } from "@hercule/client-core";
import { snoozeTimerQuery } from "./queries";

/**
 * The longest delay `setTimeout` keeps. A longer one runs after 1 ms
 * instead. When a timer this long fires, nothing has run out yet, the read
 * returns the same `until`, and the timer waits again.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * How long after `until` the timer first fires. Firing a second late gives
 * the controller's clock time to pass `until` too, when it runs a little
 * behind this Mac's.
 */
const CONTROLLER_CLOCK_MARGIN_MS = 1_000;

/** The longest wait between two reads while the controller's clock has not reached `until`. */
const MAX_RETRY_DELAY_MS = 60_000;

/**
 * Runs the snooze timer while it is mounted, and renders nothing. Mount it
 * once, in the shell, whose loader has read the soonest `until`.
 */
export function SnoozeTimer({ client }: { readonly client: HerculeClient }): null {
  const queryClient = useQueryClient();
  const until = useSuspenseQuery(snoozeTimerQuery(client)).data;

  useEffect(() => {
    if (until === null) return;
    const runsOutAt = Date.parse(until);
    const readUntilAgain = (): void => {
      invalidateWithoutCancelling(queryClient, snoozeTimerQuery(client).queryKey);
    };
    let retryDelay = CONTROLLER_CLOCK_MARGIN_MS;
    let timer: ReturnType<typeof setTimeout>;
    const fire = (): void => {
      readUntilAgain();
      // A read that returns another `until` ends this effect, and this timer
      // with it. One that returns the same `until` leaves it to try again.
      timer = setTimeout(fire, retryDelay);
      retryDelay = Math.min(2 * retryDelay, MAX_RETRY_DELAY_MS);
    };
    timer = setTimeout(
      fire,
      Math.min(
        MAX_TIMER_DELAY_MS,
        Math.max(0, runsOutAt - Date.now()) + CONTROLLER_CLOCK_MARGIN_MS,
      ),
    );
    const readIfRunOut = (): void => {
      if (document.visibilityState === "visible" && Date.now() >= runsOutAt) readUntilAgain();
    };
    document.addEventListener("visibilitychange", readIfRunOut);
    window.addEventListener("focus", readIfRunOut);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", readIfRunOut);
      window.removeEventListener("focus", readIfRunOut);
      // The `until` changed after it ran out: the snoozed signal has left
      // Later, so To do, Later and Done are read again now. This reads the
      // `until` once more too, which returns what it just did.
      if (Date.now() >= runsOutAt) invalidateWithoutCancelling(queryClient, queryKeys.signals());
    };
  }, [client, queryClient, until]);

  return null;
}
