/**
 * Remembers why the last text generation failed, so Settings can show it.
 *
 * The failure is kept in memory only. It describes the controller's current
 * state, not history: the audit entries hold the history. A restart clears
 * it, which is correct because the first call after a restart tells the truth
 * again.
 *
 * A failure is stored with the value of the `textGeneration.model` setting
 * the call ran under, and read back only for that same value. So choosing
 * another model hides the failure of the old one at once, even when a call
 * that started before the change fails after it.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type { TextGenerationFailureReason } from "@hercule/contract";

/** Why one text generation failed, and when. */
export interface TextGenerationFailure {
  readonly reason: TextGenerationFailureReason;
  readonly message: string;
  /** An ISO-8601 timestamp. */
  readonly at: string;
}

const make = Effect.gen(function* () {
  const last = yield* Ref.make<{
    readonly setting: string;
    readonly failure: TextGenerationFailure;
  } | null>(null);

  return {
    /**
     * Returns the last failure, or null when the last call succeeded, none
     * has run, or the last failure happened under another value of the
     * setting than `setting` (JSON, as `TextGenerationTarget.setting`).
     */
    read: (setting: string): Effect.Effect<TextGenerationFailure | null> =>
      Effect.map(Ref.get(last), (held) => (held?.setting === setting ? held.failure : null)),

    /** Replaces the last failure, which happened under the value `setting` of the setting. */
    record: (setting: string, failure: TextGenerationFailure): Effect.Effect<void> =>
      Ref.set(last, { setting, failure }),

    /** Forgets the last failure. Called when a text generation succeeds. */
    clear: (): Effect.Effect<void> => Ref.set(last, null),
  };
});

/** The last text generation failure. */
export class LastTextGenerationFailure extends Context.Service<
  LastTextGenerationFailure,
  Effect.Success<typeof make>
>()("hercule/controller/text-generation/LastTextGenerationFailure") {}

export const LastTextGenerationFailureLayer: Layer.Layer<LastTextGenerationFailure> =
  Layer.effect(LastTextGenerationFailure)(make);
