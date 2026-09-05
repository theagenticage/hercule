/**
 * Which fleet runner is the one on the machine the user is sitting at.
 *
 * The controller cannot answer this: it knows every runner and where none of
 * them are. Only the browser can, by asking each reported loopback port who is
 * there - a runner on another machine simply does not answer on 127.0.0.1. So
 * the port is a fact the runner reports, the fetch never leaves the machine,
 * and the only thing taken from an answer is an id that is already in the
 * fleet list. An answer naming anything else is discarded rather than
 * believed.
 *
 * It is a convenience, and a wrong answer would be worse than none: silence,
 * a hang and a stranger's answer all mean "no local runner", and the caller
 * offers the user a runner by name instead.
 */
import type { Runner } from "@hydra/contract";
import type { FetchLike } from "./client";

/** How long a loopback endpoint has to say who is there before nobody waits. */
export const IDENTITY_TIMEOUT_MS = 1000;

/** Where a runner on this machine answers, and the only address ever asked. */
const identityUrl = (port: number): string => `http://127.0.0.1:${String(port)}/identity`;

/**
 * The id in an answer, or nothing when there is no id in it.
 *
 * Nothing else about the answer is checked - not its status, not the rest of
 * its shape - because the id is compared against one the caller already holds.
 * Anything on the port that is not this runner fails that comparison whatever
 * it said.
 */
const identityIn = async (response: Response): Promise<unknown> => {
  return ((await response.json()) as { readonly runnerId?: unknown }).runnerId;
};

/**
 * Who answers on one port, or nothing.
 *
 * The wait is bounded here rather than left to the browser: a port held by
 * something that accepts a connection and then says nothing would otherwise
 * keep the whole detection pending for as long as the page is open.
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

/**
 * The id of the runner on this machine, or `null` when nothing on it answers
 * for one.
 *
 * Each online runner's own reported port is asked, and only that runner's own
 * id is taken from it. Accepting any fleet id from any port would let a machine
 * with nothing on it be told it is a machine somewhere else - and the alias
 * decides where a person's next session runs, so being wrong is worse than
 * answering nothing.
 *
 * The whole fleet listing is handed in and the online runners are picked out
 * here, so a caller cannot forget to.
 */
export const detectLocalRunner = async (
  runners: ReadonlyArray<Runner>,
  fetch: FetchLike,
  timeoutMs: number = IDENTITY_TIMEOUT_MS,
): Promise<string | null> => {
  const reachable = runners.flatMap((runner) =>
    runner.state === "online" && runner.facts !== null
      ? [{ id: runner.id, port: runner.facts.identityPort }]
      : [],
  );
  const answers = await Promise.all(
    reachable.map(async ({ id, port }) => ({
      id,
      answered: await whoIsOn(port, fetch, timeoutMs),
    })),
  );
  return answers.find(({ id, answered }) => answered === id)?.id ?? null;
};
