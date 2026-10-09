/**
 * The port through which a freeze asks to be thawed when its promotion token
 * expires.
 *
 * The promotion domain decides that a freeze ends at the token's expiry. It
 * never hosts the timer: a domain holds no long-lived fibers (ADR 0033). The
 * controller daemon implements this port and runs the sleep on a fiber of
 * the controller's lifetime.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** Schedules the thaw of a freeze when its promotion token expires. */
export class PromotionExpiry extends Context.Service<
  PromotionExpiry,
  {
    /**
     * Arranges for the freeze of `tokenId` to thaw at `until`, and returns
     * at once. A thaw that finds the controller already serving or sealed
     * does nothing. Calling this again for another token leaves the earlier
     * timer in place: that thaw names its own token and will not lift the
     * new freeze.
     */
    readonly scheduleThaw: (tokenId: string, until: Date) => Effect.Effect<void>;
  }
>()("hercule/controller/promotion/PromotionExpiry") {}
