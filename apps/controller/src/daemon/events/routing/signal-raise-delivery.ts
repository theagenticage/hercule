/**
 * The delivery of signal raises: turns each raise the intake routing table
 * wrote into a signal (spec 10 §9.2).
 *
 * It reads the pending raises instead of remembering what the router just
 * wrote, so a raise whose signal was not written, because the controller was
 * stopped first, is written on a later pass. The runnable workflows, which
 * give each signal its Hand to an agent actions, are read once per pass.
 *
 * Raises go out one at a time, oldest event first, each through
 * `SignalRaises.raise`, which owns the rules. A raise that fails is logged
 * and stays pending for the next pass, and the next raise still goes out.
 *
 * The delivery passes the promotion gate itself, once for the reads that
 * start a pass and once for each raise, rather than once for the whole
 * pass. A raise may wait up to `BUILD_TIMEOUT_SECONDS` on its `build`, so a
 * pass of several raises can take minutes. A freeze then waits only for the
 * raise that is running, and the raises after it wait at the gate until the
 * freeze ends.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { PromotionState } from "../../../promotion";
import { SignalRaises } from "../../../signals";
import { workflowRepository } from "../../../workflows";
import { absorbFailures } from "../../absorbing";
import type { Delivery } from "../event-router";

export const signalRaiseDelivery: Effect.Effect<
  Delivery,
  never,
  SqlClient.SqlClient | SignalRaises | PromotionState
> = Effect.gen(function* () {
  const raises = yield* SignalRaises;
  const promotion = yield* PromotionState;
  const workflows = yield* workflowRepository;

  return {
    name: "signal raises",
    deliverWaiting: (): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const pass = yield* promotion.whenServing(
          Effect.gen(function* () {
            const pending = yield* raises.listPending();
            const runnable = pending.length === 0 ? [] : yield* workflows.listRunnableDefinitions();
            return { pending, runnable };
          }),
        );
        for (const raise of pass.pending) {
          yield* absorbFailures(
            `Raising the ${raise.kind} signal from the event ${raise.eventId} failed`,
            promotion.whenServing(raises.raise(raise, pass.runnable)),
          );
        }
      }),
  };
});
