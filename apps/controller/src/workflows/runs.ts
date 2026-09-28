import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { SqlError } from "effect/unstable/sql/SqlError";

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
