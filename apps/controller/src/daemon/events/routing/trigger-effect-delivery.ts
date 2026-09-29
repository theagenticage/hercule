/**
 * The delivery of trigger effects: starts a run for every start trigger that
 * matched an event and has no run yet.
 *
 * It reads the pending rows instead of remembering what the router just
 * wrote, so a match whose run did not start, because the controller was
 * killed between the routing pass and the start, starts on the next tick.
 *
 * Runs start one at a time, in the order their events matched, each in its
 * own transaction (`TriggerEffects.startRun`). A start that fails but may
 * work on a later try is logged, its effect stays pending for the next tick,
 * and the next one still starts. A start only writes to the database and
 * hands the run to the Run Executor after the commit, so it never waits on a
 * runner and needs no fiber of its own.
 */
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { TriggerEffects } from "../../../workflows";
import { absorbFailures } from "../../absorbing";
import type { Delivery } from "../event-router";

export const triggerEffectDelivery: Effect.Effect<Delivery, never, TriggerEffects> = Effect.gen(
  function* () {
    const triggerEffects = yield* TriggerEffects;

    return {
      name: "trigger effects",
      deliverWaiting: (): Effect.Effect<void, SqlError> =>
        Effect.gen(function* () {
          for (const id of yield* triggerEffects.listPendingIds()) {
            yield* absorbFailures(
              `Starting the run of the trigger effect ${String(id)} failed`,
              triggerEffects.startRun(id),
            );
          }
        }),
    };
  },
);
