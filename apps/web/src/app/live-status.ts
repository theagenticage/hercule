/**
 * What the app does when the live connection reports the credential is gone.
 *
 * Every other refusal reaches the reader through something they asked for: a
 * screen reads, the controller answers 401, `client-core` drops the token and
 * the entry guard sends them to the login screen on the next navigation. The
 * live connection asks for tickets on its own, so its refusal happens while
 * nobody is looking, and without this the screen would go on showing what it
 * last read until the reader navigated.
 *
 * Invalidating the router runs the entry guard again, which is that same path:
 * with no token left, the guard answers the login screen.
 */
import type { Live } from "@hydra/client-core";

/** Watches for as long as the app lives, which is as long as the connection does. */
export const followLiveStatus = (live: Live, router: { invalidate(): Promise<void> }): void => {
  live.onStatus((status) => {
    if (status === "unauthenticated") void router.invalidate();
  });
};
