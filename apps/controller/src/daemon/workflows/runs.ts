import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { runRepository, RunService } from "../../runs";
import { TriggeredRuns, WorkflowRuns } from "../../workflows";

/**
 * Provides the workflows domain's `WorkflowRuns` from the runs domain's rows.
 * It lives in the controller daemon because the runs domain depends on the
 * workflows domain, so neither domain can connect the two without a cycle.
 */
export const WorkflowRunsLayer: Layer.Layer<WorkflowRuns, never, SqlClient.SqlClient> =
  Layer.effect(WorkflowRuns)(
    Effect.map(runRepository, (runs) => ({ hasUnfinishedRun: runs.hasUnfinishedRun })),
  );

/**
 * Provides the workflows domain's `TriggeredRuns` from the run service, for
 * the same reason as `WorkflowRunsLayer`.
 */
export const TriggeredRunsLayer: Layer.Layer<TriggeredRuns, never, RunService> = Layer.effect(
  TriggeredRuns,
)(Effect.map(RunService, (runs) => ({ start: runs.startTriggeredRun })));
