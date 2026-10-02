/**
 * The mark the welcome leaves in the page's session storage while it starts
 * Hercule on this Mac.
 *
 * When the start succeeds, main saves the controller's URL and reloads the
 * window, so the page that asked for the start is gone. The reloaded page
 * finds a controller on this Mac that is not set up, which it would greet as
 * found. The mark tells it the user already pressed Open the office, so it
 * goes straight to the account step. Session storage lives as long as the
 * window and survives the reload.
 */

const START_REQUESTED_KEY = "first-run.start-requested";

/** Records that the user asked to start Hercule, before the start runs. */
export const markStartRequested = (): void => {
  sessionStorage.setItem(START_REQUESTED_KEY, "1");
};

/** Forgets the request, after a start that did not end in a reload. */
export const clearStartRequested = (): void => {
  sessionStorage.removeItem(START_REQUESTED_KEY);
};

/**
 * Returns whether the user asked to start Hercule before the last reload, and
 * forgets it, so a later launch greets the controller as found again.
 */
export const takeStartRequested = (): boolean => {
  const requested = sessionStorage.getItem(START_REQUESTED_KEY) !== null;
  clearStartRequested();
  return requested;
};
