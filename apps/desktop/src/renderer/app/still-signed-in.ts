/**
 * Telling whether the user who started something is still the one signed in.
 * A request that waits (a read before a spawn, a Try again that is on its way)
 * can end after sign-out, and the next account must not receive what the
 * previous one asked for. The client sends the token it holds at the moment of
 * each call, so a late call would go out as the next account.
 */
import type { HerculeClient } from "@hercule/client-core";

/**
 * Returns a function that reports whether `client` still holds the token it
 * holds now. Sign-out and a later sign-in each change the token, and a token
 * never comes back, so a `false` stays `false`. Call this when the user asks
 * for something, and ask the returned function before any later step that
 * would act for them.
 */
export const buildStillSignedInCheck = (
  client: Pick<HerculeClient, "getToken">,
): (() => boolean) => {
  const token = client.getToken();
  return () => client.getToken() === token;
};
