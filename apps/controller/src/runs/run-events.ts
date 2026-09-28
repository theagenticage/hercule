/**
 * The platform events a run emits when it ends: `run.completed`, `run.failed`
 * and `run.cancelled`, and the `core.run-failed` notification a failed run
 * raises. The run engine writes them from the single place a run ends
 * (`writeRunEnding` in `engine.ts`), in the transaction that ends it.
 */
import type { EventId, FailureReason, Run, StepRecord } from "@hercule/contract";
import type { PlatformEvent } from "../events";
import type { CoreNotification } from "../notifications";
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
  actor: PlatformEvent["actor"],
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

/** The sentence for each failure reason, for a run whose record holds nothing more precise. */
const FAILURE_SENTENCES: Record<FailureReason, string> = {
  "expression-error": "A template or a condition could not be evaluated.",
  "step-failed": "A step failed.",
  "iteration-limit": "An edge was followed as often as its limit allows.",
  "controller-error": "The controller could not carry out the run. Its log has the details.",
  "workspace-failed": "The run's workspace could not be set up.",
};

/**
 * Returns a sentence saying why a run failed: the failed edge's message, or
 * the error of the step record that failed, or else the sentence for the
 * failure reason.
 */
const describeRunFailure = (
  run: Run,
  outcome: Extract<RunOutcome, { readonly status: "failed" }>,
): string => {
  const stepId = outcome.failedStepId;
  if ("failedEdge" in outcome && outcome.failedEdge !== undefined) {
    return `The run stopped after step \`${stepId}\`: ${outcome.failedEdge.message}`;
  }
  const failed = run.steps.findLast(
    (record): record is Extract<StepRecord, { readonly status: "failed" }> =>
      record.stepId === stepId && record.status === "failed",
  );
  return failed !== undefined
    ? `Step \`${stepId}\` failed: ${failed.error.message}`
    : FAILURE_SENTENCES[outcome.failureReason];
};

/**
 * Builds the `core.run-failed` notification for a run that failed with
 * `outcome`. `eventId` is the run's `run.failed` event, which the
 * notification links to. The subject is the run, and its workflow when the
 * run was started from a stored one, so the notification is listed with both.
 */
export const buildRunFailedNotification = (
  run: Run,
  outcome: Extract<RunOutcome, { readonly status: "failed" }>,
  eventId: EventId,
): CoreNotification => ({
  kind: "core.run-failed",
  title: `Run of ${run.plan.name} failed`,
  body: describeRunFailure(run, outcome),
  subject: [
    { kind: "run", id: run.id },
    ...(run.workflowId === null ? [] : [{ kind: "workflow" as const, id: run.workflowId }]),
  ],
  eventId,
});
