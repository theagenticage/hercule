/**
 * The driver that ends a promotion freeze at its promotion token's expiry
 * (spec 03 section 8.2).
 *
 * A machine that pulled a transfer and then went quiet, without a switch or
 * a cancel, would otherwise leave this controller frozen forever. The
 * promotion domain stores each freeze's deadline in its phase and knows how
 * to thaw. This module only waits for the deadline, because a fiber that
 * runs for the life of the process belongs to the controller daemon, not to
 * a domain.
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { PromotionState, type PromotionPhase } from "../../promotion";

/**
 * Watches the promotion phase and thaws each freeze when its deadline
 * passes. Never returns.
 *
 * Only the newest phase counts: when a freeze ends early, by a seal, a
 * cancel or a broken transfer, its wait is dropped, so it can never thaw a
 * later freeze for another token. A thaw that finds the controller sealed
 * has nothing to undo, and is ignored.
 */
export const thawExpiredFreezes: Effect.Effect<never, never, PromotionState> = Effect.gen(
  function* () {
    const promotion = yield* PromotionState;
    const thawAtDeadline = (freeze: Extract<PromotionPhase, { readonly _tag: "Frozen" }>) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.sleep(Duration.millis(Math.max(0, freeze.until.getTime() - now)));
        const thawed = yield* Effect.orElseSucceed(promotion.thaw(freeze.tokenId), () => false);
        if (thawed) {
          yield* Effect.logWarning(
            "The promotion token expired before the new machine switched over, so the " +
              "promotion freeze has ended and this controller serves again.",
          );
        }
      });
    yield* promotion.phaseChanges.pipe(
      Stream.switchMap((phase) =>
        phase._tag === "Frozen" ? Stream.fromEffect(thawAtDeadline(phase)) : Stream.empty,
      ),
      Stream.runDrain,
    );
    // The phase stream never ends, so neither does the driver.
    return yield* Effect.never;
  },
);
