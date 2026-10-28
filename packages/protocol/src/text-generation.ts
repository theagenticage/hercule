/**
 * The frames of a text generation: one model call on a runner, with no tools,
 * no workspace, no transcript and no turn (spec 06 section 14). The controller
 * sends instructions, an input and an output schema; the runner answers with
 * a value that matches the schema, or with why it has none.
 *
 * A text generation is not a Session. It has no session row and takes no
 * session slot, so none of the session frames carry it.
 */
import { Schema } from "effect";
import { OutputSchema } from "./output-schema";
import { Fact, InstanceId, InstanceSecrets, MAX_MESSAGE_LENGTH } from "./primitives";
import { Usage } from "./sessions";

/**
 * The capability for text generation. A runner lists it at hello when it
 * answers `TextGenerationRequest`, and the controller when it sends one. A
 * runner on an older build closes the socket on a frame it cannot read, so
 * the controller sends a text generation only to a runner that lists this.
 */
export const TEXT_GENERATION_CAPABILITY = "textGeneration";

/**
 * The longest instructions, and the longest input, a text generation carries.
 * A text generation is meant to be small and cheap; 64 KiB each is far more
 * than a title, a summary or an extraction needs, and keeps the request well
 * under the frame limit.
 */
export const MAX_TEXT_GENERATION_TEXT_LENGTH = 64 * 1024;

/**
 * How long the runner lets one text generation run before it stops the
 * harness and answers `timeout`. The runner always answers within this time,
 * or its connection ends, so the controller can hold the call's slot until
 * the answer arrives and never count a harness as finished while it still
 * runs.
 */
export const TEXT_GENERATION_DEADLINE_MS = 60_000;

/**
 * How many text generations one runner makes at once. The controller sends a
 * runner no more than this many, and the runner refuses any call over it, so
 * a burst of calls cannot start more harnesses than this on one machine.
 */
export const MAX_CONCURRENT_TEXT_GENERATIONS_PER_RUNNER = 10;

const Text = Schema.String.check(Schema.isMaxLength(MAX_TEXT_GENERATION_TEXT_LENGTH));

// Never blank: the controller shows the message to the user as the reason a
// call failed, and an empty reason explains nothing.
const NonBlankMessage = Schema.String.check(
  Schema.isPattern(/\S/, { title: "message", description: "text that is not only whitespace" }),
  Schema.isMaxLength(MAX_MESSAGE_LENGTH),
);

/** What one text generation asks the model: the same for every provider. */
export const TextGenerationSpec = Schema.Struct({
  /** The model, as the instance's model list names it. A text generation takes no model options. */
  model: Fact,
  /** What the model is told to do. Given to the harness as its system prompt. */
  instructions: Text,
  /** What the model works on. Given to the harness as the one user message. */
  input: Text,
  /** The JSON Schema the answer must match. */
  outputSchema: OutputSchema,
});

export type TextGenerationSpec = Schema.Schema.Type<typeof TextGenerationSpec>;

/**
 * Asks the runner to make one text generation on a provider instance. The
 * instance's config and credentials live on the controller, so the request
 * carries them, as `ProbeRequest` does.
 */
export const TextGenerationRequest = Schema.Struct({
  _tag: Schema.Literal("textGenerationRequest"),
  requestId: Fact,
  instanceId: InstanceId,
  providerId: Fact,
  config: Schema.Json,
  /** The instance's credentials, which its config never holds; `{}` when none. */
  secrets: InstanceSecrets,
  spec: TextGenerationSpec,
});

export type TextGenerationRequest = Schema.Schema.Type<typeof TextGenerationRequest>;

/**
 * How a text generation ended on the runner:
 *
 * - `ok`: the answer matched the output schema. `usage` is null when the
 *   harness reported no token counts.
 * - `invalid-output`: the harness answered, but not with a value that matches
 *   the output schema. `reason` describes what did not match.
 * - `timeout`: the harness ran past `TEXT_GENERATION_DEADLINE_MS` and the
 *   runner stopped it.
 * - `failed`: the call did not produce an answer at all: the harness would
 *   not start, was not logged in, or errored.
 */
export const TextGenerationOutcome = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("ok"),
    value: Schema.Json,
    usage: Schema.NullOr(Usage),
  }),
  Schema.Struct({ outcome: Schema.Literal("invalid-output"), reason: NonBlankMessage }),
  Schema.Struct({ outcome: Schema.Literal("timeout") }),
  Schema.Struct({ outcome: Schema.Literal("failed"), message: NonBlankMessage }),
]);

export type TextGenerationOutcome = Schema.Schema.Type<typeof TextGenerationOutcome>;

export const TextGenerationReport = Schema.Struct({
  _tag: Schema.Literal("textGenerationReport"),
  requestId: Fact,
  outcome: TextGenerationOutcome,
});

export type TextGenerationReport = Schema.Schema.Type<typeof TextGenerationReport>;
