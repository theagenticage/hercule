/**
 * The last open thread, which the app opens again at launch (spec 17
 * §Native behaviour).
 *
 * The app opens again what was open at quit: the thread whose screen was
 * showing, or the new-thread screen when no thread was. So a user who leaves
 * a thread for `/` and quits gets `/` at the next launch.
 *
 * The thread's id is kept in `localStorage`, one entry per controller URL,
 * because a thread id means nothing to another controller. The thread's
 * route keeps the entry:
 *
 * - its loader writes the entry each time a thread's screen loads;
 * - leaving the thread's screen for a screen that shows no thread removes it;
 * - when the thread turns out to be gone, the entry is removed whatever it
 *   holds, because the screen open now shows no thread.
 *
 * Quitting the app navigates nowhere, so the thread open at quit stays stored.
 *
 * A thread opened at launch is marked in its history entry's state. The user
 * did not ask for that thread this time, so when it is gone the thread's
 * route shows the new-thread screen instead of "This thread was not found."
 */
import { createMemoryHistory, type RouterHistory } from "@tanstack/react-router";
import { isId } from "@hercule/contract";

/** Returns the `localStorage` key that holds the last open thread for `controllerUrl`. */
const buildStorageKey = (controllerUrl: string): string => `last-thread:${controllerUrl}`;

/** Stores `sessionId` as the last open thread for `controllerUrl`. */
export const rememberLastThread = (controllerUrl: string, sessionId: string): void => {
  localStorage.setItem(buildStorageKey(controllerUrl), sessionId);
};

/**
 * Returns the last open thread's id for `controllerUrl`, or `null` when none
 * is stored. A stored value that is not an id is treated as none, so the app
 * never opens a malformed path.
 */
export const readLastThread = (controllerUrl: string): string | null => {
  const stored = localStorage.getItem(buildStorageKey(controllerUrl));
  return isId(stored) ? stored : null;
};

/**
 * Removes `sessionId` as the last open thread for `controllerUrl`. Leaves the
 * entry alone when it holds another thread, which the user opened since.
 */
export const forgetLastThread = (controllerUrl: string, sessionId: string): void => {
  if (localStorage.getItem(buildStorageKey(controllerUrl)) === sessionId) {
    localStorage.removeItem(buildStorageKey(controllerUrl));
  }
};

/**
 * Removes the last open thread for `controllerUrl`, whichever thread it is.
 * A thread that turns out to be gone is the one open now, so nothing is left
 * to reopen at launch.
 */
export const clearLastThread = (controllerUrl: string): void => {
  localStorage.removeItem(buildStorageKey(controllerUrl));
};

/**
 * Creates the history the app starts with. It starts at the last open thread
 * of `controllerUrl` when one is stored, marked as opened at launch, and at
 * `/` otherwise, including when no controller is saved.
 */
export const createLaunchHistory = (controllerUrl: string | null): RouterHistory => {
  const history = createMemoryHistory();
  const sessionId = controllerUrl === null ? null : readLastThread(controllerUrl);
  if (sessionId !== null) history.replace(`/threads/${sessionId}`, { reopenedAtLaunch: true });
  return history;
};

/**
 * Checks whether a history entry's state marks it as the thread the app
 * opened at launch. Any navigation after launch makes a new entry, or
 * replaces this one, without the mark.
 */
export const isReopenedAtLaunch = (state: object): boolean =>
  "reopenedAtLaunch" in state && state.reopenedAtLaunch === true;
