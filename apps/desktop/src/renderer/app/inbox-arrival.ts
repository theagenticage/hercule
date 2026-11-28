/**
 * The newest Inbox arrival this client has shown the user. The sidebar's
 * Inbox row draws one small dot while the controller reports a newer arrival
 * (`InboxCounts.newestArrival`), so something new that came while the user
 * was elsewhere can still be found.
 *
 * The value is an arrival sequence number, never a time: it is opaque and
 * only ever compared. It is kept in `localStorage`, one entry per controller
 * URL and user name, because the number belongs to that controller's counter
 * and, as the unread state, to what that user has seen on this device. The
 * sidebar reads it while it draws, so a change is announced to subscribers.
 */

/** Returns the `localStorage` key that holds the acknowledged arrival of `username` on `controllerUrl`. */
const buildStorageKey = (controllerUrl: string, username: string): string =>
  `inbox-arrival:${controllerUrl}:${username}`;

const listeners = new Set<() => void>();

/**
 * Returns the newest arrival acknowledged for `username` on `controllerUrl`,
 * or 0 when none is stored or the stored text is not a whole number. 0 is
 * below every arrival, so a first launch shows the dot while the Inbox holds
 * anything that arrived.
 */
export const readAcknowledgedInboxArrival = (controllerUrl: string, username: string): number => {
  const stored = Number(localStorage.getItem(buildStorageKey(controllerUrl, username)));
  return Number.isSafeInteger(stored) && stored > 0 ? stored : 0;
};

/**
 * Stores `newestArrival` as acknowledged, and tells the subscribers when the
 * stored value rose. The Inbox screen calls it with the `newestArrival` of
 * each Inbox reply it shows. A lower value changes nothing: a reply that
 * was read before a newer one, and shown after it, must not bring the dot
 * back.
 */
export const acknowledgeInboxArrival = (
  controllerUrl: string,
  username: string,
  newestArrival: number,
): void => {
  if (newestArrival <= readAcknowledgedInboxArrival(controllerUrl, username)) return;
  localStorage.setItem(buildStorageKey(controllerUrl, username), String(newestArrival));
  for (const listener of listeners) listener();
};

/** Calls `listener` after every rise of an acknowledged arrival. Returns the function that unsubscribes. */
export const subscribeInboxArrival = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
