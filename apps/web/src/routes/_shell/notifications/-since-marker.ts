/**
 * The notification center's "since you last checked" marker (spec 10 §8),
 * wired to the URL and the settings store. `@hercule/client-core` decides what
 * the pin and the marker mean; this hook does the navigation and the write.
 */
import { useEffect, useRef } from "react";
import { useMutation, useSuspenseQuery, type QueryClient } from "@tanstack/react-query";
import { chooseNewSince, choosePinOnOpen, type HerculeClient } from "@hercule/client-core";
import { settingsQuery } from "../../../app/queries";

/** The user setting that holds the notification center's marker. */
const MARKER = "lastChecked.notifications";

/**
 * Opens the notification center, and returns the instant it counts new
 * notifications from (`undefined` when every notification is new), with the
 * error of the marker write if that write failed.
 *
 * On opening, while the URL has no pin, the hook:
 *
 * 1. pins the stored marker in the URL through `pinInUrl`, so a refresh keeps
 *    the same notifications new;
 * 2. then writes now as the stored marker, so the next visit counts from this
 *    one.
 *
 * The pin lands before the write, so the screen never counts from the new
 * marker. This runs in an effect, not in the route's loader, because the router
 * preloads a route when the pointer rests on a link to it, and resting on a
 * link is not opening the screen.
 */
export function useSinceMarker({
  client,
  queryClient,
  pin,
  pinInUrl,
}: {
  readonly client: HerculeClient;
  readonly queryClient: QueryClient;
  /** The URL's `since`, parsed by `parseSincePin`. */
  readonly pin: string | undefined;
  /** Replaces the URL's `since` with the given pin, without a new history entry. */
  readonly pinInUrl: (pin: string) => Promise<void>;
}): { readonly since: string | undefined; readonly advanceError: Error | null } {
  const stored = useSuspenseQuery(settingsQuery(client)).data.user[MARKER];
  const { mutateAsync: advance, error } = useMutation({
    mutationFn: (now: string) => client.settings.update({ payload: { user: { [MARKER]: now } } }),
    onSuccess: (updated) => {
      queryClient.setQueryData(settingsQuery(client).queryKey, updated);
    },
  });
  // Set while pinning and writing, so a second run of the effect in that
  // window, such as React's development double run, does not open twice.
  const opening = useRef(false);

  useEffect(() => {
    if (pin !== undefined || opening.current) return;
    opening.current = true;
    const now = new Date().toISOString();
    pinInUrl(choosePinOnOpen(stored))
      .then(() => advance(now))
      // A failed write is returned as `advanceError` for the screen to show.
      .catch(() => undefined)
      .finally(() => {
        opening.current = false;
      });
  }, [pin, stored, pinInUrl, advance]);

  return { since: chooseNewSince(pin, stored), advanceError: error };
}
