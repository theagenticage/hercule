/**
 * What a client knows about connections that is not a plain read.
 *
 * The OAuth redirect URI is derived from the origin the browser is at: the
 * controller cannot see it, and it is what the user registers with the
 * provider, so the screen that shows it and the service that builds it read the
 * same function.
 */

/** The path the controller serves the provider's redirect on. */
const CALLBACK_PATH = "/oauth/callback";

/** The redirect URI to register for this origin, with no doubled slash. */
export const redirectUriFor = (origin: string): string =>
  `${origin.replace(/\/+$/, "")}${CALLBACK_PATH}`;
