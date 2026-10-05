/**
 * The routing table for runs: one route per live subscription a run holds,
 * which is one per signal trigger of each running run.
 *
 * This is the only module that imports both subscriptions and runs for
 * routing, so neither of them has to know how the other routes events. It
 * holds no rules of its own: whether a matched event belongs to the run, and
 * what the run then does, is the run service's decision.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Notifier } from "../../../notifications";
import { RunService } from "../../../runs";
import { subscriptionRepository } from "../../../subscriptions";
import type { Route, RoutingTable } from "../event-router";
import { buildSubscriptionFailureRecorder } from "./subscription-health";

/** One route per live run-held subscription. */
export const signalRoutingTable: Effect.Effect<
  RoutingTable,
  never,
  SqlClient.SqlClient | RunService | Notifier
> = Effect.gen(function* () {
  const runs = yield* RunService;
  const subscriptions = yield* subscriptionRepository;
  const recordEvaluationFailure = yield* buildSubscriptionFailureRecorder;

  /**
   * Returns the live run-held subscriptions as routes. A subscription admits
   * every event: its condition, the signal trigger's Event Selector, is its
   * only test. Nothing is swept first, because a run ends its subscriptions
   * in the same transaction that ends the run.
   */
  const prepare = (): Effect.Effect<ReadonlyArray<Route>, SqlError> =>
    Effect.map(subscriptions.listLive("run"), (live) =>
      live.flatMap(({ id, holder, target, condition, healthErrorMessage }): Array<Route> => {
        // A run holds a subscription only for a signal trigger of its plan.
        if (target.kind !== "signal") return [];
        return [
          {
            admits: () => true,
            condition,
            hasEvaluationError: healthErrorMessage !== null,
            writeOnMatch: (event, context) =>
              runs.recordSignalMatch({
                runId: holder.id,
                triggerId: target.triggerId,
                event,
                context,
              }),
            recordEvaluationFailure: (message) => recordEvaluationFailure(id, message),
            clearEvaluationFailure: () => subscriptions.clearEvaluationFailure(id),
          },
        ];
      }),
    );

  return { prepare };
});
