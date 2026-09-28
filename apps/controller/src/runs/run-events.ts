/**
 * The platform events a run emits when it ends: `run.completed`, `run.failed`
 * and `run.cancelled`, and the `core.run-failed` notification a failed run
 * raises. The run engine writes them from the single place a run ends
 * (`writeRunEnding` in `engine.ts`), in the transaction that ends it.
 */
import type {
  EventId,
  FailureReason,
  NotificationSubject,
  Run,
  StepRecord,
} from "@hercule/contract";
import type { PlatformEvent } from "../events";
import type { CoreNotification, UnlessRaised } from "../notifications";
import { computeTriggerQuietSince } from "../workflows";
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
          ...("failedStepId" in outcome && outcome.failedStepId !== undefined
            ? { failedStepId: outcome.failedStepId }
            : {}),
          ...("failedEdge" in outcome && outcome.failedEdge !== undefined
            ? { failedEdge: outcome.failedEdge }
            : {}),
          ...("failureMessage" in outcome ? { failureMessage: outcome.failureMessage } : {}),
        },
      };
    case "cancelled":
      return { kind: "run.cancelled", actor, at, payload: fields };
  }
};

/** The sentence for each failure reason, for a run whose record holds nothing more precise. */
const FAILURE_SENTENCES: Record<FailureReason, string> = {
  "validation-error":
    "The run could not start, because its workflow or its inputs did not validate.",
  "expression-error": "A template or a condition could not be evaluated.",
  "step-failed": "A step failed.",
  "iteration-limit": "An edge was followed as often as its limit allows.",
  "controller-error": "The controller could not carry out the run. Its log has the details.",
  "workspace-failed": "The run's workspace could not be set up.",
};

/** The outcome of a run that failed. */
type FailedOutcome = Extract<RunOutcome, { readonly status: "failed" }>;

/**
 * Returns a sentence saying why a run failed: the failed edge's message, or
 * the error of the step record that failed, or else the sentence for the
 * failure reason.
 */
const describeRunFailure = (run: Run, outcome: FailedOutcome): string => {
  if (outcome.failureReason === "validation-error") {
    return `The run could not start. ${outcome.failureMessage}`;
  }
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
 * Builds the notification subject of the start trigger that started `run`,
 * or returns `undefined` for a run that no trigger started.
 */
const buildStartingTriggerSubject = (run: Run): NotificationSubject | undefined =>
  run.origin.kind === "trigger" && run.workflowId !== null
    ? { kind: "trigger", workflowId: run.workflowId, triggerId: run.origin.triggerId }
    : undefined;

/**
 * Builds the `core.run-failed` notification for a run that failed with
 * `outcome`. `eventId` is the run's `run.failed` event, which the
 * notification links to. The subject is the run, its workflow when the run
 * was started from a stored one, and the start trigger that started it, if
 * one did, so the notification is listed with each.
 */
export const buildRunFailedNotification = (
  run: Run,
  outcome: FailedOutcome,
  eventId: EventId,
): CoreNotification => {
  const trigger = buildStartingTriggerSubject(run);
  return {
    kind: "core.run-failed",
    title: `Run of ${run.plan.name} failed`,
    body: describeRunFailure(run, outcome),
    subject: [
      { kind: "run", id: run.id },
      ...(run.workflowId === null ? [] : [{ kind: "workflow" as const, id: run.workflowId }]),
      ...(trigger === undefined ? [] : [trigger]),
    ],
    eventId,
  };
};

/**
 * Decides when the `core.run-failed` notification of a run that failed at
 * `at` is held back, as the `unlessRaised` option of `createCoreNotification`.
 * A run a start trigger started that failed validation is held back when a
 * notification about a run of the same trigger was raised within the
 * trigger quiet period. Returns `undefined` for every other failed run,
 * whose notification is always raised.
 *
 * A trigger whose runs fail validation fails the same way on every event it
 * matches, so a burst of events would otherwise raise one notification per
 * event. Each run still fails where the user can see it.
 */
export const decideRunFailedUnlessRaised = (
  run: Run,
  outcome: FailedOutcome,
  at: string,
): UnlessRaised | undefined => {
  const trigger = buildStartingTriggerSubject(run);
  if (trigger === undefined || outcome.failureReason !== "validation-error") return undefined;
  return { since: computeTriggerQuietSince(at), about: [trigger] };
};
