/**
 * Creates the first user, the step that completes setup. The web app and the
 * desktop app both call `completeSetup`, so the rule about the one-time setup
 * token is written once.
 */
import type { SetupPayload, SetupResult } from "@hercule/contract";
import type { HerculeClient } from "./client";

/**
 * Sends `setup.complete` with `setupToken` as the bearer token, and returns
 * the controller's reply. Fails with the client's error when the controller
 * refuses the setup, for example because the token is stale.
 *
 * The setup token is presented, never stored: the call uses it up, and an app
 * closed during the call must leave no credential behind. When the call
 * succeeds, the client stores the login token from the reply in its own token
 * store, so this function never touches storage. That is why it works for the
 * web app's `localStorage` and the desktop app's keychain alike. When the call
 * fails, the setup token is taken back, so no later call sends it.
 */
export const completeSetup = async (
  client: HerculeClient,
  setupToken: string,
  payload: typeof SetupPayload.Type,
): Promise<typeof SetupResult.Type> => {
  client.presentToken(setupToken);
  try {
    return await client.setup.complete({ payload });
  } catch (error) {
    client.presentToken(null);
    throw error;
  }
};
