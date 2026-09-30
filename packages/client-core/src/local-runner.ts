/**
 * Detects which runner in the fleet runs on the user's own machine. The
 * controller knows every runner but not where any of them is, so only the
 * browser can find out, by asking each runner's loopback identity port which
 * runner is listening there.
 *
 * A wrong result would be worse than none. So an error, a timeout, and a
 * response with an unexpected id all mean "no local runner", and the caller
 * falls back to choosing a runner by name.
 */
import type { Runner } from "@hercule/contract";
import type { FetchLike } from "./client";

export const IDENTITY_TIMEOUT_MS = 1000;

/**
 * Asks the identity endpoint on 127.0.0.1 at `port` which runner is listening
 * there, and resolves with the runner id it answers. A rejection, or any
 * value but the id the caller expects, means "not that runner". `signal`
 * aborts the request once detection stops waiting for it.
 *
 * The web app asks with `fetch`, see `buildFetchIdentityProbe`. The desktop
 * app asks through its main process, because its page may reach only the
 * controller.
 */
export type IdentityProbe = (port: number, signal: AbortSignal) => Promise<unknown>;

/**
 * Returns an `IdentityProbe` that sends `GET http://127.0.0.1:<port>/identity`
 * with `fetch` and resolves with the `runnerId` of the JSON body. Nothing else
 * in the body is checked, because the caller compares the id with the one it
 * expects, and any other value fails that comparison.
 */
export const buildFetchIdentityProbe =
  (fetch: FetchLike): IdentityProbe =>
  async (port, signal) => {
    const response = await fetch(`http://127.0.0.1:${String(port)}/identity`, { signal });
    return ((await response.json()) as { readonly runnerId?: unknown }).runnerId;
  };

/**
 * Asks `port` which runner is listening, and resolves with its id, or with
 * `undefined` on an error or a timeout. The timeout is set here rather than
 * left to the probe: a port that accepts a connection and never responds
 * would otherwise keep detection pending for the life of the page.
 */
const probeWithTimeout = (
  port: number,
  probe: IdentityProbe,
  timeoutMs: number,
): Promise<unknown> =>
  new Promise((resolve) => {
    const control = new AbortController();
    const expiry = setTimeout(() => {
      control.abort();
      resolve(undefined);
    }, timeoutMs);
    const settle = (id: unknown): void => {
      clearTimeout(expiry);
      resolve(id);
    };
    probe(port, control.signal).then(settle, () => settle(undefined));
  });

export interface LoopbackEndpoint {
  readonly id: string;
  readonly port: number;
}

/**
 * Returns the identity port of each online runner. Exported because the
 * detection result depends on exactly these endpoints, so a caller that caches
 * the result must use them as its cache key.
 */
export const listLoopbackEndpoints = (
  runners: ReadonlyArray<Runner>,
): ReadonlyArray<LoopbackEndpoint> =>
  runners.flatMap((runner) =>
    runner.connectivity === "online" && runner.facts !== null
      ? [{ id: runner.id, port: runner.facts.identityPort }]
      : [],
  );

/**
 * Returns the id of the local runner, or `null` when none is found. A port
 * counts only when it responds with the id of the runner that reported that
 * port. Accepting any fleet id from any port could mistake a runner on another
 * machine for the local one, and the local runner decides where the user's
 * next session runs. When two runners both answer on their own ports, both
 * are on this machine and either could be meant, so neither is picked.
 *
 * Each port is asked once, however many runners report it: runners on
 * different machines usually all listen on the default port.
 *
 * The caller passes the whole runner list, so it cannot forget to filter it.
 */
export const detectLocalRunner = async (
  runners: ReadonlyArray<Runner>,
  probe: IdentityProbe,
  timeoutMs: number = IDENTITY_TIMEOUT_MS,
): Promise<string | null> => {
  const endpoints = listLoopbackEndpoints(runners);
  const ports = [...new Set(endpoints.map(({ port }) => port))];
  const answers = await Promise.all(ports.map((port) => probeWithTimeout(port, probe, timeoutMs)));
  const [found, alsoFound] = endpoints.filter(
    ({ id, port }) => answers[ports.indexOf(port)] === id,
  );
  return alsoFound === undefined ? (found?.id ?? null) : null;
};
