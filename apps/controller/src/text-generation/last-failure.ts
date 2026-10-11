/**
 * Remembers why the last text generation failed, so Settings can show it.
 *
 * The failure is kept in memory only. It describes the controller's current
 * state, not history: the audit entries hold the history. A restart clears
 * it, which is correct because the first call after a restart tells the truth
 * again.
 *
 * A failure is stored under a key that names the `textGeneration.model`
 * setting value and what it resolved to when the call ran
 * (`TextGenerationTarget.failureKey`). It is read back only under that same
 * key. So choosing another model hides the failure of the old one at once,
 * and so does `automatic` resolving to another model. A call that started
 * before the change and fails after it stays hidden too.
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
    readonly key: string;
    readonly failure: TextGenerationFailure;
  } | null>(null);

  return {
    /**
     * Returns the last failure, or null when the last call succeeded, none
     * has run, or the last failure happened under another key than `key`.
     */
    read: (key: string): Effect.Effect<TextGenerationFailure | null> =>
      Effect.map(Ref.get(last), (held) => (held?.key === key ? held.failure : null)),

    /** Replaces the last failure, which happened under the key `key`. */
    record: (key: string, failure: TextGenerationFailure): Effect.Effect<void> =>
      Ref.set(last, { key, failure }),

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
