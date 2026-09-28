/**
 * The routing table for start triggers: one route per start trigger that can
 * start a run now, which is an active trigger on an enabled workflow.
 *
 * The rules are the workflows domain's; this table only adapts them to the
 * router. A match is recorded as a pending trigger effect
 * (`recordTriggerMatch`), and the trigger effect delivery starts the run
 * later, so a routing pass only writes rows and never waits on a run. A
 * failed filter or input mapping is recorded on the trigger's health
 * (`TriggerHealth`), which also decides when the user hears about it.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  admitsEvent,
  recordTriggerMatch,
  TriggerHealth,
  workflowRepository,
} from "../../../workflows";
import type { Route, RoutingTable } from "../event-router";

/** One route per start trigger that can start a run now. */
export const triggerRoutingTable: Effect.Effect<
  RoutingTable,
  never,
  SqlClient.SqlClient | TriggerHealth
> = Effect.gen(function* () {
  const repository = yield* workflowRepository;
  const health = yield* TriggerHealth;
  const sql = yield* SqlClient.SqlClient;

  return {
    /**
     * Returns a route per active start trigger on an enabled workflow. The
     * filter is passed on as stored: the router parses it, and a filter that
     * no longer parses is recorded as an error of that one trigger.
     */
    prepare: (): Effect.Effect<ReadonlyArray<Route>, SqlError> =>
      Effect.map(repository.listRoutableStartTriggers(), (triggers) =>
        triggers.map((trigger): Route => ({
          admits: (event) => admitsEvent(trigger, event),
          condition: trigger.filter,
          hasHealthError: trigger.hasHealthError,
          writeOnMatch: (event, context) =>
            Effect.provideService(
              recordTriggerMatch(trigger, event, context),
              SqlClient.SqlClient,
              sql,
            ),
          recordEvaluationFailure: (message) =>
            health.recordFailure(trigger, "evaluation", message),
          clearEvaluationFailure: () => health.clearFailure(trigger),
        })),
      ),
  };
});
