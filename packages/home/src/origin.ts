/**
 * The address a process on this machine opens the controller at, built from
 * `bind.host` and `bind.port`. The controller, which needs it for its local
 * runner and its setup URL, and `hercule service`, which reports it, both
 * build it here so they cannot disagree.
 */

/**
 * The hostnames `URL` gives the two addresses that mean "every interface".
 * `URL` rewrites every other spelling of them, such as `0:0:0:0:0:0:0:0`, into
 * one of these.
 */
const WILDCARD_HOSTNAMES = new Set(["0.0.0.0", "[::]"]);

/** Returns a host as it goes into a URL: an IPv6 literal in brackets, anything else as it is. */
const bracketIpv6 = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

/**
 * Checks whether a bind host means "every interface": `0.0.0.0` or `::`, in
 * any spelling `bind.host` accepts, such as `[::]` or `0:0:0:0:0:0:0:0`.
 * Returns false for a value that is not a host at all.
 */
export function isWildcardHost(host: string): boolean {
  try {
    return WILDCARD_HOSTNAMES.has(new URL(`http://${bracketIpv6(host)}`).hostname);
  } catch {
    return false;
  }
}

/**
 * Returns the origin a process on this machine uses to reach the controller,
 * such as `http://127.0.0.1:4937`. A wildcard bind host becomes loopback,
 * because nothing can open `http://0.0.0.0:4937`; an IPv6 literal is put in
 * brackets. `bind.host` is validated when the config is loaded, so here it is
 * only a host.
 */
export function buildControllerOrigin(bindHost: string, bindPort: number): string {
  const host = isWildcardHost(bindHost) ? "127.0.0.1" : bindHost;
  return `http://${bracketIpv6(host)}:${bindPort}`;
}
