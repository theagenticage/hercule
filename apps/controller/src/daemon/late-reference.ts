/**
 * A reference that holds a service which cannot be built yet, and is set once
 * it is. Boot uses one where two layers each need the other: the first layer
 * is built with an empty reference, and a fill layer sets it as soon as the
 * second layer is built. Boot builds every layer before it serves any request
 * or hears from any runner, so nothing reads the reference before it is set.
 */
import * as Effect from "effect/Effect";

/** A holder for a service that is set once, after the layer that reads it is built. */
export interface LateReference<A> {
  /** Sets the reference. Called once, by the fill layer. */
  readonly set: (value: A) => void;
  /** Returns the value. Dies when it is not set yet, which is a bug in boot. */
  readonly get: Effect.Effect<A>;
}

/**
 * Builds an empty `LateReference`. `unsetMessage` is the message `get` dies
 * with when it runs before `set`, and says which layer boot must fill.
 */
export const makeLateReference = <A>(unsetMessage: string): LateReference<A> => {
  let held: A | undefined;
  return {
    set: (value) => {
      held = value;
    },
    get: Effect.suspend(() =>
      held === undefined ? Effect.die(unsetMessage) : Effect.succeed(held),
    ),
  };
};
