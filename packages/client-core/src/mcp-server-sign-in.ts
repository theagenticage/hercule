/** The first port of the dynamic range, which no program is assigned to. */
const FIRST_DYNAMIC_PORT = 49152;
/** The last port there is. */
const LAST_PORT = 65535;

/**
 * Builds the redirect URI the web app gives `mcpServer.startSignIn`:
 * `http://127.0.0.1:<port>/callback`, for a random port from 49152 to 65535.
 *
 * A browser cannot listen on a port, so nothing listens there. After the
 * user approves the sign-in, the browser shows an error page for this
 * address, and the user pastes that address back (spec 14, Settings > MCP
 * servers). The address carries the `code` and `state` the controller needs
 * for `mcpServer.finishSignIn`.
 */
export const buildPastedRedirectUri = (): string => {
  const port =
    FIRST_DYNAMIC_PORT + Math.floor(Math.random() * (LAST_PORT - FIRST_DYNAMIC_PORT + 1));
  return `http://127.0.0.1:${String(port)}/callback`;
};
