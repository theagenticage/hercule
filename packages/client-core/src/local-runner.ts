/**
 * Which fleet runner is the one on the machine the user is sitting at. The
 * controller knows every runner and where none of them are, so only the browser
 * can tell, by asking each reported loopback port who is there.
 *
 * A wrong answer would be worse than none, so silence, a hang and a stranger's
 * answer all mean "no local runner" and the caller falls back to a runner by name.
 */
import type { Runner } from "@hercule/contract";
import type { FetchLike } from "./client";

export const IDENTITY_TIMEOUT_MS = 1000;

const identityUrl = (port: number): string => `http://127.0.0.1:${String(port)}/identity`;

/**
 * Nothing else about the answer is checked, because the id is compared against
 * one the caller already holds and anything else fails that comparison.
 */
const identityIn = async (response: Response): Promise<unknown> => {
  return ((await response.json()) as { readonly runnerId?: unknown }).runnerId;
};

/**
 * The wait is bounded here rather than left to the browser: a port that accepts
 * a connection and says nothing would keep detection pending for the page's life.
 */
const whoIsOn = (port: number, fetch: FetchLike, timeoutMs: number): Promise<unknown> =>
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
    void fetch(identityUrl(port), { signal: control.signal })
      .then(identityIn)
      .then(settle, () => settle(undefined));
  });

export interface LoopbackEndpoint {
  readonly id: string;
  readonly port: number;
}

/**
 * Exported because what is asked is what an answer depends on, and a caller
 * caching that answer has to key it on the same set.
 */
export const loopbackEndpoints = (
  runners: ReadonlyArray<Runner>,
): ReadonlyArray<LoopbackEndpoint> =>
  runners.flatMap((runner) =>
    runner.connectivity === "online" && runner.facts !== null
      ? [{ id: runner.id, port: runner.facts.identityPort }]
      : [],
  );

/**
 * Only the id of the runner whose own port answered is taken. Accepting any
 * fleet id from any port would let a machine be told it is one somewhere else,
 * and the alias decides where a person's next session runs.
 *
 * The whole listing is handed in so a caller cannot forget to filter it.
 */
export const detectLocalRunner = async (
  runners: ReadonlyArray<Runner>,
  fetch: FetchLike,
  timeoutMs: number = IDENTITY_TIMEOUT_MS,
): Promise<string | null> => {
  const answers = await Promise.all(
    loopbackEndpoints(runners).map(async ({ id, port }) => ({
      id,
      answered: await whoIsOn(port, fetch, timeoutMs),
    })),
  );
  return answers.find(({ id, answered }) => answered === id)?.id ?? null;
};
