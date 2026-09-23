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

const buildIdentityUrl = (port: number): string => `http://127.0.0.1:${String(port)}/identity`;

/**
 * Reads the runner id from an identity response. Nothing else in the response
 * is checked, because the caller compares the id with the one it expects, and
 * any other value fails that comparison.
 */
const readRunnerId = async (response: Response): Promise<unknown> => {
  return ((await response.json()) as { readonly runnerId?: unknown }).runnerId;
};

/**
 * Asks the identity port which runner is listening, and resolves with its id,
 * or with `undefined` on an error or a timeout. The timeout is set here rather
 * than left to the browser: a port that accepts a connection and never
 * responds would otherwise keep detection pending for the life of the page.
 */
const fetchRunnerIdOnPort = (port: number, fetch: FetchLike, timeoutMs: number): Promise<unknown> =>
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
    void fetch(buildIdentityUrl(port), { signal: control.signal })
      .then(readRunnerId)
      .then(settle, () => settle(undefined));
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
 * next session runs.
 *
 * The caller passes the whole runner list, so it cannot forget to filter it.
 */
export const detectLocalRunner = async (
  runners: ReadonlyArray<Runner>,
  fetch: FetchLike,
  timeoutMs: number = IDENTITY_TIMEOUT_MS,
): Promise<string | null> => {
  const answers = await Promise.all(
    listLoopbackEndpoints(runners).map(async ({ id, port }) => ({
      id,
      answered: await fetchRunnerIdOnPort(port, fetch, timeoutMs),
    })),
  );
  return answers.find(({ id, answered }) => answered === id)?.id ?? null;
};
