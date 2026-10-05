/**
 * Signing out, which the app menu's Sign Out and Settings > Profile's Sign out
 * button both do.
 */
import type { RegisteredRouter } from "@tanstack/react-router";
import type { SavedController } from "./context";
import { revokeToken } from "./controller-client";
import { LOGIN_PATH } from "./entry-guard";

/**
 * Signs the user out of `controller` and shows the sign-in screen through
 * `router`. Returns at once and never fails.
 *
 * Sign Out never waits on the controller (spec 17, Auth and the token). A
 * controller that hangs must not keep a user signed in who asked to be signed
 * out, and a quit in that moment must not leave the token on disk. So Sign
 * Out, in this order:
 *
 * - forgets the token, in memory and in main's store;
 * - stops the live connection, without waiting for it to close;
 * - asks the controller to revoke the token, and ignores the answer;
 * - shows the sign-in screen. Once it shows, the router empties the query
 *   cache and its cache of past screens (see `createAppRouter`).
 *
 * The screen stays on display until the navigation ends. With the live
 * connection stopped, later pushes no longer make it read again, but it can
 * still send a read that was already on its way: the second read that
 * `invalidateWithoutCancelling` runs after a read in progress, or a read that
 * `useRelatedReads` starts for a record the thread list names. That read goes
 * out with no token, and the controller refuses it. Nothing is lost: the
 * token is already forgotten, and the caches are emptied once the sign-in
 * screen shows.
 *
 * The revoke is a plain call rather than a `useMutation`: no screen shows its
 * progress or its outcome.
 */
export const signOut = (
  controller: SavedController,
  router: Pick<RegisteredRouter, "navigate">,
): void => {
  const token = controller.client.getToken();
  controller.client.setToken(null);
  void controller.live.stop();
  if (token !== null) revokeToken(controller.url, token);
  void router.navigate({ to: LOGIN_PATH });
};
