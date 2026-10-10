/**
 * The driver that writes the runner departures a promotion freeze held back
 * (spec 03 section 8.2).
 *
 * A runner whose connection ends while the controller is frozen must not be
 * written off `online` then, because the copy the new machine takes would miss
 * the write. The runners domain holds the departure in memory and knows how to
 * write it. This module only waits for the controller to serve again, because
 * a fiber that runs for the life of the process belongs to the controller
 * daemon, not to a domain.
 */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { PromotionState } from "../../promotion";
import { RunnerConnections } from "../../runners";
import { absorbFailures } from "../absorbing";

/**
 * Writes the held runner departures each time the controller starts serving
 * again, after a freeze ends without a seal. Never returns. A write that fails
 * is logged, and its departures stay held for a later pass.
 *
 * The phase stream starts with the current phase, so the first pass runs at
 * once and finds nothing held. A sealed controller never serves again, so its
 * held departures are never written: its runners follow the forwarding
 * pointer to the new machine.
 */
export const recordDeparturesAfterThaws: Effect.Effect<
  never,
  never,
  RunnerConnections | PromotionState
> = Effect.gen(function* () {
  const connections = yield* RunnerConnections;
  const promotion = yield* PromotionState;
  yield* promotion.phaseChanges.pipe(
    Stream.filter((phase) => phase._tag === "Serving"),
    Stream.runForEach(() =>
      absorbFailures(
        "Moving runners that disconnected during a promotion freeze off online failed",
        connections.recordHeldDepartures,
      ),
    ),
  );
  // The phase stream never ends, so neither does the driver.
  return yield* Effect.never;
});
