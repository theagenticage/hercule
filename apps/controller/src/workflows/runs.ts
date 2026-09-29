import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Event } from "@hercule/contract";
import type { PendingTriggerEffect } from "./trigger-effects";

/**
 * What the workflows domain needs to know about a workflow's runs: whether one
 * is still pending or running, because such a workflow cannot be deleted.
 *
 * The runs are not read here directly. The runs domain depends on the
 * workflows domain, so the workflows domain cannot import it back without
 * making the domain graph a cycle. So the workflows domain declares what it
 * needs as this service, and the controller daemon provides it from the runs
 * domain (`WorkflowRunsLayer`). The workflows domain keeps the rule about
 * deleting and only asks the question, so neither domain imports the other.
 * ADR 0033 describes this way of breaking a cycle between domains.
 */
export class WorkflowRuns extends Context.Service<
  WorkflowRuns,
  {
    /**
     * Checks whether a run of the workflow is pending or running. Runs in the
     * caller's transaction, so a delete that checks first sees the same rows it
     * then deletes.
     */
    readonly hasUnfinishedRun: (workflowId: string) => Effect.Effect<boolean, SqlError>;
  }
>()("hercule/controller/workflows/WorkflowRuns") {}

/**
 * How the workflows domain starts the run of a start trigger that matched an
 * event. The runs domain writes runs, and it depends on the workflows domain,
 * so this is a port like `WorkflowRuns`: the controller daemon provides it
 * from the run service (`TriggeredRunsLayer`).
 */
export class TriggeredRuns extends Context.Service<
  TriggeredRuns,
  {
    /**
     * Writes the run of `effect`, the match of one start trigger on `event`,
     * in the caller's transaction, and returns the run's id. The run is handed
     * to the Run Executor once the transaction commits. A run whose workflow
     * or inputs do not validate is still written, and fails at once with
     * `validation-error`, so the user sees why the trigger's run did not run.
     */
    readonly start: (
      effect: PendingTriggerEffect,
      event: Event,
      at: string,
    ) => Effect.Effect<string, SqlError>;
  }
>()("hercule/controller/workflows/TriggeredRuns") {}
