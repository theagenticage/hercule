import * as Schema from "effect/Schema";

/**
 * The failure of `ProviderAdapter.respondToQuestion` when the user's answer
 * did not reach the agent, or when the adapter cannot tell whether it did.
 *
 * The runner reports it to the controller as a failed
 * `SessionRespondToQuestionResult`, so the user is told and can answer again.
 * The message is shown to the user as written, so it says what went wrong and
 * whether the answer may still have arrived.
 */
export class AnswerNotDelivered extends Schema.TaggedError<AnswerNotDelivered>()(
  "AnswerNotDelivered",
  { message: Schema.String },
) {}
