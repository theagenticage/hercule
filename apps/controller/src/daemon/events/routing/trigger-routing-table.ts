/**
 * The routing table for start triggers: one route per start trigger that
 * matches events now, which is a trigger on an enabled and valid workflow
 * that is active or paused by the breaker. A trigger the breaker paused
 * still matches, so that its matches are held rather than lost.
 *
 * The rules are the workflows domain's; this table only adapts them to the
 * router. A match is recorded as a pending trigger effect
 * (`TriggerEffects.recordMatch`), and the trigger effect delivery starts the
 * run later, so a routing pass only writes rows and never waits on a run. A
 * failed filter or input mapping is recorded on the trigger's health
 * (`TriggerHealth`), which also decides when the user hears about it.
 */
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";
import { admitsEvent, TriggerEffects, TriggerHealth } from "../../../workflows";
import type { Route, RoutingTable } from "../event-router";

/** One route per start trigger that matches events now. */
export const triggerRoutingTable: Effect.Effect<
  RoutingTable,
  never,
  TriggerHealth | TriggerEffects
> = Effect.gen(function* () {
  const health = yield* TriggerHealth;
  const triggerEffects = yield* TriggerEffects;

  return {
    /**
     * Returns a route per start trigger that matches events now. The filter
     * is passed on as stored: the router parses it, and a filter that no
     * longer parses is recorded as an error of that one trigger.
     */
    prepare: (): Effect.Effect<ReadonlyArray<Route>, SqlError> =>
      Effect.map(triggerEffects.listRoutableStartTriggers(), (triggers) =>
        triggers.map((trigger): Route => ({
          admits: (event) => admitsEvent(trigger, event),
          condition: trigger.filter,
          hasEvaluationError: trigger.hasEvaluationError,
          writeOnMatch: (event, context) => triggerEffects.recordMatch(trigger, event, context),
          recordEvaluationFailure: (message) =>
            health.recordFailure(trigger, "evaluation", message),
          clearEvaluationFailure: () => health.clearFailure(trigger, "evaluation"),
        })),
      ),
  };
});
