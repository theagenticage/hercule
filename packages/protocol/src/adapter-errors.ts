/**
 * The ways a harness adapter fails to start a session or to take an input,
 * one class per kind of failure.
 *
 * The runner sends one of these in a refused `SessionInputResult`, and the
 * controller decides from its `_tag` what happens to the input and to the
 * session. Every class carries a `message` that is written for the user and
 * shown as written, so it describes what went wrong and, where it helps, what to
 * do next.
 */
import { Schema } from "effect";

import { Message } from "./primitives";

/**
 * The failure of `startSession` when the harness is not installed on the
 * runner: its binary is missing or cannot be run.
 */
export class HarnessNotInstalled extends Schema.TaggedError<HarnessNotInstalled>()(
  "HarnessNotInstalled",
  { message: Message },
) {}

/**
 * The failure of `startSession` when the harness is installed but its
 * Provider Account has no login on this runner.
 */
export class HarnessLoginMissing extends Schema.TaggedError<HarnessLoginMissing>()(
  "HarnessLoginMissing",
  { message: Message },
) {}

/**
 * The failure of `startSession` when the runner already hosts a live harness
 * for this session. The start is a duplicate and changes nothing.
 */
export class SessionAlreadyRunning extends Schema.TaggedError<SessionAlreadyRunning>()(
  "SessionAlreadyRunning",
  { message: Message },
) {}

/**
 * The failure of `startSession` when the session is being resumed but the
 * harness's own record of the conversation is not on this runner.
 */
export class ResumeTranscriptMissing extends Schema.TaggedError<ResumeTranscriptMissing>()(
  "ResumeTranscriptMissing",
  { message: Message },
) {}

/**
 * The failure of an adapter call that needs a live harness for the session
 * (such as `sendInput`) when the runner hosts none, or the one it hosts is
 * stopping or has exited.
 */
export class SessionNotRunning extends Schema.TaggedError<SessionNotRunning>()(
  "SessionNotRunning",
  { message: Message },
) {}

/**
 * The failure of `sendInput` when the harness certainly did not take the
 * input: the session stopped before the input was handed over, or the harness
 * refused it.
 */
export class InputNotDelivered extends Schema.TaggedError<InputNotDelivered>()(
  "InputNotDelivered",
  { message: Message },
) {}

/**
 * The failure of `sendInput` when the harness cannot take this input into the
 * turn that is running, but would run it as the next turn.
 *
 * It is separate from the other failures because the supervisor treats it
 * differently. Any other failure means the input failed, so the supervisor
 * also reports a `runtime.error` in the thread. This refusal is an expected
 * deferral: the input stays queued and runs when the turn ends, so the
 * supervisor only answers the controller with a refused result carrying this
 * error, and the thread shows nothing.
 *
 * The message is shown to the user as written, so it describes what happens to
 * the input.
 */
export class SteerRefused extends Schema.TaggedError<SteerRefused>()("SteerRefused", {
  message: Message,
}) {}

/**
 * The failure of `sendInput` when the input asks for a model or a thinking
 * level that the harness refused to switch to. The session keeps running with
 * the model it had.
 */
export class ModelChangeRefused extends Schema.TaggedError<ModelChangeRefused>()(
  "ModelChangeRefused",
  { message: Message },
) {}

/**
 * The failure of a call to the harness when the conversation with its process
 * broke down and it is not known whether the call took effect: the process
 * went away, the call timed out, a write failed, or the reply was malformed.
 */
export class HarnessProtocolError extends Schema.TaggedError<HarnessProtocolError>()(
  "HarnessProtocolError",
  { message: Message },
) {}

/**
 * Any failure of `startSession` or `sendInput` that none of the other classes
 * describes, such as a skill that cannot be applied, a settings file that
 * cannot be written, or an image that cannot be read.
 */
export class AdapterFailed extends Schema.TaggedError<AdapterFailed>()("AdapterFailed", {
  message: Message,
}) {}

/** Every failure a harness adapter can report for a session start or an input. The `_tag` identifies the class. */
export const AdapterError = Schema.Union([
  HarnessNotInstalled,
  HarnessLoginMissing,
  SessionAlreadyRunning,
  ResumeTranscriptMissing,
  SessionNotRunning,
  InputNotDelivered,
  SteerRefused,
  ModelChangeRefused,
  HarnessProtocolError,
  AdapterFailed,
]);

export type AdapterError = Schema.Schema.Type<typeof AdapterError>;

/**
 * The failure of `HarnessAdapter.respondToQuestion` when the user's answer
 * did not reach the agent, or when the adapter cannot tell whether it did.
 *
 * The runner reports it to the controller as a failed
 * `SessionRespondToQuestionResult`, so the user is told and can answer again.
 * The message describes what went wrong and whether the answer may still have
 * arrived.
 *
 * It is not part of `AdapterError`: it is never the failure of a session start
 * or an input, so it never travels in a `SessionInputResult`.
 */
export class AnswerNotDelivered extends Schema.TaggedError<AnswerNotDelivered>()(
  "AnswerNotDelivered",
  { message: Message },
) {}
