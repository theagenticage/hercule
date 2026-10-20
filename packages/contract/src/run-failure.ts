/**
 * Words for why a run failed. The run page, a Tracking row and the controller's
 * `task.queryTracking` all say it the same way, so the words live here, where
 * the controller and every client can import them.
 */
import type { FailureReason } from "./groups/run";

/**
 * Returns a failure reason in a few plain words: "step failed", "validation
 * error" for a run a trigger could not start because its workflow or the
 * inputs mapped from the event did not validate, "expression error" for a
 * template or a condition that could not be evaluated,
 * "iteration limit" for an edge the run was to follow more often than its
 * `maxTraversals` allows, "controller error" for a run the controller
 * could not carry out, or "workspace failed" for a run whose workspace could
 * not be set up or was lost with its runner. For an agent step it returns
 * "schema failure" for a turn that ended without a value matching the step's
 * output schema, and "session failed" for a turn or session that failed
 * before the turn ended.
 */
export const describeFailureReason = (reason: FailureReason): string => {
  switch (reason) {
    case "validation-error":
      return "validation error";
    case "step-failed":
      return "step failed";
    case "expression-error":
      return "expression error";
    case "iteration-limit":
      return "iteration limit";
    case "controller-error":
      return "controller error";
    case "workspace-failed":
      return "workspace failed";
    case "schema-failure":
      return "schema failure";
    case "session-failed":
      return "session failed";
  }
};

/**
 * Returns why a failed run failed, in a few words for a row's line, such as
 * "permission denied on ops-db": the `message` of the failure when the run
 * recorded one (its `failureMessage`, the message of the edge it failed at,
 * or the error of the step record that failed), else the failure reason in
 * plain words.
 */
export const describeFailureCause = (failure: {
  readonly reason: FailureReason;
  readonly message: string | undefined;
}): string => failure.message ?? describeFailureReason(failure.reason);
