/**
 * Reads the Sentry user out of what the host knows about a Connection.
 * `validate` returned an account id `<organization id>:<user id>` and a
 * display name `<organization name> · <username>`, and the host passes both
 * back to the event source, so nothing is stored twice.
 */

/** The separator `validate` puts between the organization name and the username. */
const DISPLAY_NAME_SEPARATOR = " · ";

/** Returns the user id from an account id of the form `<organization id>:<user id>`. */
export const readUserId = (accountId: string): string =>
  accountId.slice(accountId.lastIndexOf(":") + 1);

/**
 * Returns the username from a display name of the form `<organization name> ·
 * <username>`. A display name without the separator is returned as it is.
 */
export const readUsername = (displayName: string): string => {
  const at = displayName.lastIndexOf(DISPLAY_NAME_SEPARATOR);
  return at === -1 ? displayName : displayName.slice(at + DISPLAY_NAME_SEPARATOR.length);
};
