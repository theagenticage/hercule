/**
 * The bind warning.
 *
 * Hercule's supported perimeter is a LAN or a tailnet, and it serves plain HTTP.
 * Binding somewhere that is neither loopback nor a tailnet address is allowed -
 * it is the user's network - but it is said out loud, once, at startup. Hercule
 * warns; it never refuses.
 *
 * "Tailnet" is Tailscale's CGNAT range `100.64.0.0/10` and its IPv6 range
 * `fd7a:115c:a1e0::/48`; those two ranges are pinned here. A wildcard bind
 * warns as well: it includes every interface the machine has, which is exactly
 * what the warning is about.
 */

const isLoopback = (host: string): boolean =>
  host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);

/** `100.64.0.0/10` is 100.64.x.x through 100.127.x.x. */
const isTailscaleV4 = (host: string): boolean => {
  const parts = host.split(".");
  if (parts.length !== 4 || parts[0] !== "100") return false;
  const second = Number(parts[1]);
  return Number.isInteger(second) && second >= 64 && second <= 127;
};

/** `fd7a:115c:a1e0::/48`: the first three groups pin the prefix. */
const isTailscaleV6 = (host: string): boolean =>
  host
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .startsWith("fd7a:115c:a1e0:");

/**
 * The line to print before binding, or `undefined` when the bind is inside the
 * supported perimeter.
 */
export const buildPerimeterWarning = (host: string, port: number): string | undefined => {
  if (isLoopback(host) || isTailscaleV4(host) || isTailscaleV6(host)) return undefined;
  const where = host === "0.0.0.0" || host === "::" ? "every network interface" : host;
  return (
    `Hercule is listening on ${where}:${port} over plain HTTP. That is outside its ` +
    `supported perimeter of a LAN or a tailnet: anyone who can reach this address ` +
    `can reach the API. Bind to 127.0.0.1 or a tailnet address instead if that is not what you want.`
  );
};
