/**
 * The delivery of signal raises: turns each raise the intake routing table
 * wrote into a signal (spec 10 §9.2).
 *
 * It reads the pending raises instead of remembering what the router just
 * wrote, so a raise whose signal was not written, because the controller was
 * stopped first, is written on a later pass. The enabled workflows, which
 * give each signal its Hand to an agent actions, are read once per pass.
 *
 * Raises go out one at a time, oldest event first, each through
 * `SignalRaises.raise`, which owns the rules. A raise that fails is logged
 * and stays pending for the next pass, and the next raise still goes out.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { SignalRaises } from "../../../signals";
import { workflowRepository } from "../../../workflows";
import { absorbFailures } from "../../absorbing";
import type { Delivery } from "../event-router";

export const signalRaiseDelivery: Effect.Effect<
  Delivery,
  never,
  SqlClient.SqlClient | SignalRaises
> = Effect.gen(function* () {
  const raises = yield* SignalRaises;
  const workflows = yield* workflowRepository;

  return {
    name: "signal raises",
    deliverWaiting: (): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const pending = yield* raises.listPending();
        if (pending.length === 0) return;
        const enabled = yield* workflows.listEnabledDefinitions();
        for (const raise of pending) {
          yield* absorbFailures(
            `Raising the ${raise.kind} signal from the event ${raise.eventId} failed`,
            raises.raise(raise, enabled),
          );
        }
      }),
  };
});
