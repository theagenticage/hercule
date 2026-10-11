/**
 * Remembers why the last text generation failed, so Settings can show it.
 *
 * The failure is kept in memory only. It describes the controller's current
 * state, not history: the audit entries hold the history. A restart clears
 * it, which is correct because the first call after a restart tells the truth
 * again.
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
  const last = yield* Ref.make<TextGenerationFailure | null>(null);

  return {
    /** Returns the last failure, or null when the last call succeeded or none has run. */
    read: (): Effect.Effect<TextGenerationFailure | null> => Ref.get(last),

    /** Replaces the last failure. */
    record: (failure: TextGenerationFailure): Effect.Effect<void> => Ref.set(last, failure),

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
