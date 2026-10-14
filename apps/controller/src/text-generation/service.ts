/**
 * Text generation: one small model call, made on a runner, for code inside the
 * controller (spec 06 section 14, ADR 0041). Instructions, an input and an
 * output schema go in; a value that matches the schema comes out. There are
 * no tools, no workspace, no transcript and no turn, and nothing is stored but
 * the audit entry, so a call lost to a restart leaves nothing to clean up.
 *
 * The controller holds no provider login, so it cannot call a model itself:
 * every call runs on a runner, through a harness that is logged in there. The
 * controller daemon owns the wire to the runners, so it implements this
 * service; the domains, such as the runs engine, only call it.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TextGenerationFailureReason } from "@hercule/contract";
import type { OutputSchema } from "@hercule/protocol";

/**
 * Who asks for a text generation. The service writes it into the record, and
 * qualifies the purpose with it, so one caller cannot claim another's purpose.
 *
 * - `core:<domain>`: a domain of the controller, such as `core:sessions`.
 * - `plugin:<id>`: a plugin, through its host capability (no plugin can
 *   call it yet).
 * - `run:<runId>`: a workflow run, for one of its text generation steps.
 */
export type TextGenerationCaller = `core:${string}` | `plugin:${string}` | `run:${string}`;

/** One text generation, as its caller describes it. */
export interface TextGenerationCall {
  readonly caller: TextGenerationCaller;
  /**
   * What the call is for, such as `thread.title`, or a step id for a run. The
   * record holds it qualified by the caller, as `sessions/thread.title`. The
   * model never sees it.
   */
  readonly purpose: string;
  /** What the model is told to do. */
  readonly instructions: string;
  /** What the model works on. */
  readonly input: string;
  /**
   * The JSON Schema of the answer, in the subset every provider accepts (see
   * `lintOutputSchema`). It is sent to the harness, and the answer is checked
   * against it before it is returned.
   */
  readonly outputSchema: OutputSchema;
  /**
   * What the call does when no runner can take it now:
   *
   * - `wait`: it waits, without a time limit, until a runner can take it,
   *   and then makes the call. A workflow step waits, because its run has
   *   nothing better to do.
   * - `fail`: it fails at once with `unavailable`. A caller with its own
   *   fallback, such as a Thread title, fails.
   */
  readonly whenNoRunner: "wait" | "fail";
}

/**
 * Why a text generation returned no value. The reasons a status can show
 * (see `TextGenerationFailureReason`), and `off`: text generation is off in
 * Settings, so the call was never made.
 */
const TextGenerationErrorReason = Schema.Union([
  TextGenerationFailureReason,
  Schema.Literal("off"),
]);

/**
 * Why a text generation returned no value:
 *
 * - `off`: text generation is off in Settings. No runner was asked.
 * - `unavailable`: no runner can take the call now, and the caller asked to
 *   fail rather than wait. The chosen instance is logged in on no placeable
 *   runner, or the runner went away before it answered. The same call may
 *   work once a runner can take it.
 * - `failed`: a runner took the call and it failed there, or the controller
 *   could not send it, for example because the instance's credentials could
 *   not be read. Calling again at once is not expected to help.
 * - `timeout`: no answer came in time. The deadline is 60 seconds from the
 *   moment the call holds a slot on the runner; the wait for a free slot
 *   does not count. The runner reporting that its own deadline passed ends
 *   the same way.
 * - `invalid-output`: the model answered, but not with a value that matches
 *   the output schema.
 *
 * `message` explains what happened in words a user can act on. It never holds
 * the prompt or the output.
 */
export class TextGenerationError extends Schema.TaggedError<TextGenerationError>()(
  "TextGenerationError",
  {
    reason: TextGenerationErrorReason,
    message: Schema.NonEmptyString,
  },
) {}

interface TextGenerationShape {
  /**
   * Makes one text generation and waits for it. Returns the model's answer,
   * a JSON value that matches `outputSchema`, or fails with a
   * `TextGenerationError`. An output schema outside the subset every
   * provider accepts fails as `failed`, and the call is never sent.
   *
   * The call may wait: for a runner, when `whenNoRunner` is `wait`, then for
   * a free slot on the runner, then up to 60 seconds for the runner's
   * answer, and while a promotion freezes the controller, until it thaws. So
   * never call it inside a transaction, which must not span a wait on
   * anything outside the database.
   *
   * A waiting call looks for a runner again each time a runner connects,
   * becomes placeable or is retired, a provider snapshot is stored, or the
   * setting is written. The setting turned off while it waits fails it with
   * `off`. A runner that goes away before it answers is not a failure for a
   * waiting call: it looks again at once, and waits if no other runner can
   * take the call.
   *
   * Interrupting the caller stops its wait:
   *
   * - A call still waiting for a runner or for a slot is withdrawn and never
   *   sent.
   * - A call already sent runs to its end and holds its slot until the
   *   runner answers, so the limit per runner stays a count of live calls.
   *
   * Every call writes one audit entry when it ends, for how it ended,
   * except the calls refused before the controller looks for a runner: the
   * setting is off, or the output schema is outside the subset. A waiting
   * call writes nothing while it waits. A call already sent writes its entry
   * when the runner answers, even when its caller was interrupted.
   *
   * The caller decides its own fallback; nothing is retried and nothing is
   * queued beyond the waits above.
   */
  readonly generate: (call: TextGenerationCall) => Effect.Effect<unknown, TextGenerationError>;
}

export class TextGeneration extends Context.Service<TextGeneration, TextGenerationShape>()(
  "hercule/controller/text-generation/TextGeneration",
) {}
