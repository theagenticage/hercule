/**
 * Sends the user to the login screen when the live connection reports that
 * the token is no longer valid.
 *
 * Every other rejected token is found through a request the user made: a
 * screen reads, the controller responds 401, `client-core` drops the token,
 * and the entry guard sends the user to the login screen on the next
 * navigation. The live connection requests tickets on its own, so its 401 can
 * arrive while the user is doing nothing. Without this module the screen would
 * keep showing stale data until the user navigated.
 *
 * Invalidating the router runs the entry guard again, which takes that same
 * path: with no token left, the guard redirects to the login screen.
 */
import type { Live } from "@hercule/client-core";

/** Starts watching the connection status. It never stops, because the connection lives as long as the app. */
export const followLiveStatus = (live: Live, router: { invalidate(): Promise<void> }): void => {
  live.onStatus((status) => {
    if (status === "unauthenticated") void router.invalidate();
  });
};
