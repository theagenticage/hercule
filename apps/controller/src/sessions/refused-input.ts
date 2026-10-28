/**
 * The rule for what the controller does with an input a runner refused,
 * decided from the kind of failure the runner reported.
 */
import type { AdapterError } from "@hercule/protocol";

/**
 * What the controller does with an input a runner refused:
 *
 * - `requeue`: the runner certainly did not run the input, so it goes back to
 *   waiting with the failure's message as its reason, and the caller's call
 *   fails with that message.
 * - `requeueSteer`: the input goes back to waiting as for `requeue`, but the
 *   refusal is not a failure. The input runs as the next turn, so the caller
 *   is told it is queued.
 * - `fail`: the input is cancelled with the failure's message, and the
 *   caller's call fails with it.
 */
export type RefusedInputReaction = "requeue" | "requeueSteer" | "fail";

/**
 * Decides what to do with an input the runner refused with `error`.
 *
 * The switch has no default branch, so a new kind of failure does not compile
 * until it is given a reaction here.
 *
 * An input fails, instead of going back to waiting, in two cases:
 *
 * - The failure is about the session's setup (the harness is not installed or
 *   not logged in, the transcript to resume is missing). Sending the input
 *   again would fail the same way, and the runner ends the session.
 * - The failure leaves it unknown whether the harness took the input
 *   (`HarnessProtocolError`), or the input asked for a model change the
 *   harness refused (`ModelChangeRefused`). Sending the first again could run
 *   it twice when the conversation resumes, and the second would be refused
 *   again.
 */
export const decideRefusedInputReaction = (error: AdapterError): RefusedInputReaction => {
  switch (error._tag) {
    case "SessionNotRunning":
    case "InputNotDelivered":
    case "SessionAlreadyRunning":
    case "AdapterFailed":
      return "requeue";
    case "SteerRefused":
      return "requeueSteer";
    case "ModelChangeRefused":
    case "HarnessNotInstalled":
    case "HarnessLoginMissing":
    case "ResumeTranscriptMissing":
    case "HarnessProtocolError":
      return "fail";
  }
};
