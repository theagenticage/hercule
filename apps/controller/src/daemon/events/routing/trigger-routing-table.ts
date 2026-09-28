/**
 * The routing table for start triggers: one route per start trigger that can
 * start a run now, which is an active trigger on an enabled workflow.
 *
 * A route writes a pending trigger effect with the inputs the trigger mapped
 * from the event, and the trigger effect delivery starts the run later. So a
 * routing pass only writes rows and never waits on a run. A failed filter or
 * input mapping is recorded on the trigger's health by the workflow service,
 * which also decides when the user hears about it.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Event } from "@hercule/contract";
import { nowIso } from "../../../db";
import { evaluateMapping, type ExpressionError } from "../../../expressions";
import {
  admitsEvent,
  triggerEffectRepository,
  workflowRepository,
  WorkflowService,
  type RoutableStartTrigger,
} from "../../../workflows";
import type { EvaluationContext, Route, RoutingTable } from "../event-router";

/** One route per start trigger that can start a run now. */
export const triggerRoutingTable: Effect.Effect<
  RoutingTable,
  never,
  SqlClient.SqlClient | WorkflowService
> = Effect.gen(function* () {
  const repository = yield* workflowRepository;
  const workflows = yield* WorkflowService;
  const triggerEffects = yield* triggerEffectRepository;

  /**
   * Maps the event onto the workflow's inputs and writes a pending trigger
   * effect. Fails with `ExpressionError` when an input's expression fails, so
   * the router records it like a failed filter and starts no run.
   */
  const writeTriggerEffect = (
    trigger: RoutableStartTrigger,
    event: Event,
    context: EvaluationContext,
  ): Effect.Effect<void, ExpressionError | SqlError> =>
    Effect.gen(function* () {
      const inputs = yield* evaluateMapping(trigger.inputs, context);
      yield* triggerEffects.insertPending({
        workflowId: trigger.workflowId,
        triggerId: trigger.triggerId,
        eventId: event.id,
        inputs,
        at: yield* nowIso,
      });
    });

  return {
    /**
     * Returns a route per active start trigger on an enabled workflow. The
     * filter is passed on as stored: the router parses it, and a filter that
     * no longer parses is recorded as an error of that one trigger.
     */
    prepare: (): Effect.Effect<ReadonlyArray<Route>, SqlError> =>
      Effect.map(repository.listRoutableStartTriggers(), (triggers) =>
        triggers.map((trigger): Route => {
          const key = { workflowId: trigger.workflowId, triggerId: trigger.triggerId };
          return {
            admits: (event) => admitsEvent(trigger, event),
            condition: trigger.filter,
            inEvaluationError: trigger.inEvaluationError,
            writeOnMatch: (event, context) => writeTriggerEffect(trigger, event, context),
            recordEvaluationFailure: (message) =>
              workflows.recordTriggerEvaluationFailure(key, message),
            clearEvaluationFailure: () => workflows.clearTriggerEvaluationFailure(key),
          };
        }),
      ),
  };
});
