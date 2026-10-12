/**
 * The claims on signals that an action, a withdrawal or Done is working on.
 *
 * A plugin action runs outside any transaction, so the database alone cannot
 * stop a second click, a withdrawal, or a new Ignore Rule from resolving a
 * signal whose first action has not resolved it yet. The claim does. The
 * signal service takes claims, and the Ignore Rule service leaves a claimed
 * signal alone, so both must share one `SignalClaims`.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { createInvalidStateError, type InvalidState } from "@hercule/contract";

/** The claims on signals, held in memory by the one controller process. */
export class SignalClaims extends Context.Service<
  SignalClaims,
  {
    /**
     * Runs `effect` while it holds the claim on every one of the signals,
     * and gives the claims up when `effect` ends, however it ends. Fails
     * with `InvalidState`, with the message `refusal`, when another caller
     * holds the claim on any of them, and then takes none. Checking and
     * taking the claims is one synchronous step, so two requests that arrive
     * together cannot both take one.
     */
    readonly withSignalsClaimed: <A, E, R>(
      signalIds: ReadonlyArray<string>,
      refusal: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | InvalidState, R>;
    /** Checks whether a caller holds the claim on the signal with that id now. */
    readonly isClaimed: (signalId: string) => boolean;
  }
>()("hercule/controller/signals/SignalClaims") {}

export const SignalClaimsLayer: Layer.Layer<SignalClaims> = Layer.sync(SignalClaims)(() => {
  const claimed = new Set<string>();
  return {
    withSignalsClaimed: (signalIds, refusal, effect) =>
      Effect.acquireUseRelease(
        Effect.suspend(() => {
          if (signalIds.some((id) => claimed.has(id))) {
            return Effect.fail(createInvalidStateError(refusal));
          }
          for (const id of signalIds) claimed.add(id);
          return Effect.void;
        }),
        () => effect,
        () =>
          Effect.sync(() => {
            for (const id of signalIds) claimed.delete(id);
          }),
      ),
    isClaimed: (signalId) => claimed.has(signalId),
  };
});
