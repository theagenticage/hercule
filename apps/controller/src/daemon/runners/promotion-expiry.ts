/**
 * The controller daemon's implementation of `PromotionExpiry`: a FiberSet
 * of thaw timers, one per freeze that is still waiting out its token.
 *
 * The promotion domain owns the rule (thaw at the token's expiry). This
 * module owns the fiber that sleeps until then, because a domain holds no
 * long-lived fibers (ADR 0033).
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import { PromotionExpiry, PromotionState } from "../../promotion";

export const PromotionExpiryLayer: Layer.Layer<PromotionExpiry, never, PromotionState> =
  Layer.effect(
    PromotionExpiry,
    Effect.gen(function* () {
      const promotion = yield* PromotionState;
      const runInBackground = yield* FiberSet.makeRuntime();
      return PromotionExpiry.of({
        scheduleThaw: (tokenId, until) =>
          Effect.sync(() => {
            runInBackground(
              Effect.andThen(
                Effect.sleep(Duration.millis(Math.max(0, until.getTime() - Date.now()))),
                Effect.ignore(promotion.thaw(tokenId)),
              ),
            );
          }),
      });
    }),
  );
