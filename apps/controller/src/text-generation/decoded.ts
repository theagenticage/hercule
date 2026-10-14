/**
 * Text generation for a caller that describes its answer in Effect Schema,
 * such as the Thread title. The service itself takes JSON Schema, because a
 * workflow step has nothing else; this wrapper derives one from the other.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { OutputSchema } from "@hercule/protocol";
import { deriveCatalogJsonSchema } from "../plugins";
import { TextGenerationError, type TextGenerationCall, type TextGenerationShape } from "./service";

/** One text generation whose answer is described in Effect Schema. */
export interface DecodedTextGenerationCall<A> extends Omit<TextGenerationCall, "outputSchema"> {
  /**
   * The schema of the answer. It is sent to the harness as JSON Schema, and
   * the answer is decoded with it before it is returned.
   */
  readonly output: Schema.Decoder<A>;
}

/**
 * Makes one text generation through `textGeneration` and returns the answer
 * decoded with `call.output`. Fails with a `TextGenerationError` as
 * `generate` does, and with `invalid-output` when the answer matches the
 * derived JSON Schema but does not decode, which happens only for checks
 * JSON Schema cannot express. The audit entry then still reads completed,
 * because the service wrote it before the answer was decoded.
 *
 * Dies when the schema is too large for a request frame: that is a bug in the
 * caller, not something a retry can fix.
 */
export const generateDecodedValue = <A>(
  textGeneration: TextGenerationShape,
  { output, ...call }: DecodedTextGenerationCall<A>,
): Effect.Effect<A, TextGenerationError> =>
  Effect.gen(function* () {
    // The frame bounds the schema's size and depth. A schema that cannot be
    // encoded must fail here, as the caller's bug, not later while it is sent.
    const outputSchema = yield* Effect.mapError(
      Schema.decodeUnknownEffect(OutputSchema)(deriveCatalogJsonSchema(output)),
      (error) =>
        new Error(
          `the output schema of a text generation does not fit a request frame: ${error.message}`,
        ),
    ).pipe(Effect.orDie);
    const value = yield* textGeneration.generate({ ...call, outputSchema });
    return yield* Effect.mapError(
      Schema.decodeUnknownEffect(output)(value),
      () =>
        new TextGenerationError({
          reason: "invalid-output",
          message: "the model's answer did not match the output schema",
        }),
    );
  });
