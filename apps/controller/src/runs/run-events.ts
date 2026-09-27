/**
 * The platform events a run emits when it ends: `run.completed`, `run.failed`
 * and `run.cancelled`. The run engine emits one from the single place a run
 * ends (`writeRunEnding` in `engine.ts`), in the transaction that ends it.
 */
import type { Actor as ActorStamp, Run } from "@hercule/contract";
import type { PlatformEvent } from "../events";
import type { RunOutcome } from "./repository";

/**
 * Builds the platform event for a run that ends with `outcome` at `at`,
 * caused by `actor`. `run` is the run as it was read just before it ended,
 * so it is still pending or running: a pending run never started, and its
 * event has no `startedAt`.
 */
export const buildRunEndedEvent = (
  run: Run,
  outcome: RunOutcome,
  at: string,
  actor: ActorStamp,
): PlatformEvent => {
  const fields = {
    runId: run.id,
    workflowId: run.workflowId,
    origin: run.origin,
    inputs: run.inputs,
    ...(run.status === "running" ? { startedAt: run.startedAt } : {}),
    finishedAt: at,
  };
  switch (outcome.status) {
    case "completed":
      return {
        kind: "run.completed",
        actor,
        at,
        payload: {
          ...fields,
          ...(outcome.output === undefined ? {} : { output: outcome.output }),
        },
      };
    case "failed":
      return {
        kind: "run.failed",
        actor,
        at,
        payload: {
          ...fields,
          failureReason: outcome.failureReason,
          ...(outcome.failedStepId === undefined ? {} : { failedStepId: outcome.failedStepId }),
          ...("failedEdge" in outcome && outcome.failedEdge !== undefined
            ? { failedEdge: outcome.failedEdge }
            : {}),
        },
      };
    case "cancelled":
      return { kind: "run.cancelled", actor, at, payload: fields };
  }
};
