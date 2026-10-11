/**
 * Text generation: one small model call, made on a runner, for code inside the
 * controller (spec 06 section 14, ADR 0041). Instructions, an input and an
 * output schema go in; a value that matches the schema comes out. There are
 * no tools, no workspace, no transcript and no turn, and nothing is stored but
 * the audit entry, so a call lost to a restart leaves nothing to clean up.
 *
 * The controller holds no provider login, so it cannot call a model itself:
 * every call runs on a runner, through a harness that is logged in there.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TextGenerationFailureReason } from "@hercule/contract";

/**
 * Who asks for a text generation. The service writes it into the record, and
 * qualifies the purpose with it, so one caller cannot claim another's purpose.
 *
 * - `core:<domain>`: a domain of the controller, such as `core:sessions`.
 * - `plugin:<id>`: a plugin, through its host capability (a later ticket).
 */
export type TextGenerationCaller = `core:${string}` | `plugin:${string}`;

/** One text generation, as its caller describes it. */
export interface TextGenerationRequest<A> {
  readonly caller: TextGenerationCaller;
  /**
   * What the call is for, such as `thread.title`. The record holds it
   * qualified by the caller, as `sessions/thread.title`. The model never sees
   * it.
   */
  readonly purpose: string;
  /** What the model is told to do. */
  readonly instructions: string;
  /** What the model works on. */
  readonly input: string;
  /**
   * The schema of the answer. It is sent to the harness as JSON Schema, and
   * the answer is decoded with it before it is returned.
   */
  readonly output: Schema.Decoder<A>;
}

/**
 * Why a text generation returned no value:
 *
 * - `unavailable`: no runner can take the call. Text generation is off, the
 *   chosen instance is logged in on no placeable runner, or no runner with
 *   it is connected.
 * - `timeout`: no answer came in time, including time spent waiting for a
 *   free slot on the runner.
 * - `invalid-output`: the model answered, but not with a value that matches
 *   the output schema.
 *
 * `message` says what happened in words a user can act on. It never holds the
 * prompt or the output.
 */
export class TextGenerationError extends Schema.TaggedError<TextGenerationError>()(
  "TextGenerationError",
  {
    reason: TextGenerationFailureReason,
    message: Schema.NonEmptyString,
  },
) {}

export interface TextGenerationShape {
  /**
   * Makes one text generation and waits for it, up to the text generation
   * timeout. Returns the decoded value, or fails with a `TextGenerationError`.
   * The caller decides its own fallback; nothing is retried and nothing is
   * queued.
   */
  readonly generate: <A>(
    request: TextGenerationRequest<A>,
  ) => Effect.Effect<A, TextGenerationError>;
}

export class TextGeneration extends Context.Service<TextGeneration, TextGenerationShape>()(
  "hercule/controller/daemon/TextGeneration",
) {}
