/**
 * The delivery of trigger effects: starts a run for every start trigger that
 * matched an event and has no run yet.
 *
 * It reads the pending rows instead of remembering what the router just
 * wrote, so a match whose run did not start, because the controller was
 * killed between the routing pass and the start, starts on the next tick.
 *
 * Runs start one at a time, in the order their events matched, each in its
 * own transaction (the run service's `startTriggeredRun`). A start that fails
 * on the database is logged, its effect stays pending for the next tick, and
 * the next one still starts. A start only writes to the
 * database and hands the run to the Run Executor after the commit, so it
 * never waits on a runner and needs no fiber of its own.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { RunService } from "../../../runs";
import { triggerEffectRepository } from "../../../workflows";
import { absorbFailures } from "../../absorbing";
import type { Delivery } from "../event-router";

export const triggerEffectDelivery: Effect.Effect<
  Delivery,
  never,
  SqlClient.SqlClient | RunService
> = Effect.gen(function* () {
  const triggerEffects = yield* triggerEffectRepository;
  const runs = yield* RunService;

  return {
    name: "trigger effects",
    deliverWaiting: (): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        for (const id of yield* triggerEffects.listPendingIds()) {
          yield* absorbFailures(
            `Starting the run of the trigger effect ${String(id)} failed`,
            runs.startTriggeredRun(id),
          );
        }
      }),
  };
});
