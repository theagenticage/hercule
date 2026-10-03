/**
 * Reads a controller's origin, such as `http://127.0.0.1:4937`, the way the
 * clients show it and decide where the controller runs.
 */

/**
 * Returns the host and port of a controller's origin, such as
 * `127.0.0.1:4937` for `http://127.0.0.1:4937`, as the first run's welcome
 * shows it. Returns `origin` unchanged when it does not parse.
 */
export const formatControllerAddress = (origin: string): string =>
  URL.canParse(origin) ? new URL(origin).host : origin;

/**
 * Checks whether a controller's origin is on this machine: its host is a
 * loopback address (any `127.x.x.x`, or `[::1]`) or `localhost`. Returns
 * false for an origin that does not parse.
 *
 * The first run's welcome greets a controller on this Mac as Hercule found
 * running here, and a controller elsewhere goes straight to the account step.
 */
export const isLoopbackOrigin = (origin: string): boolean => {
  if (!URL.canParse(origin)) return false;
  // The URL parser writes every IPv4 host in full, so `127.1` arrives here
  // as `127.0.0.1`.
  const { hostname } = new URL(origin);
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(hostname);
};
