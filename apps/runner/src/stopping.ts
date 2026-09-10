/**
 * Races `work` against the shutdown that a stop signal triggers.
 *
 * Its own module, and its own thin wrapper around `Effect.raceFirst`, so the
 * one thing worth testing about it - that `work` is not interrupted until
 * `shutdown` has itself returned, which is what lets a shutdown finish
 * stopping every session before the connection it was racing closes - is a
 * test that imports neither the role's `run` nor a runner's transport.
 */
import * as Effect from "effect/Effect";

export const stopping = <A, E>(
  work: Effect.Effect<A, E>,
  shutdown: Effect.Effect<void>,
): Effect.Effect<A | void, E> => Effect.raceFirst(work, shutdown);
