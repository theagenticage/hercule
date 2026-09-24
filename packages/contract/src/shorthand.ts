/**
 * Shorthand: a field whose structured value is typed as one word.
 *
 * Some fields hold a structured value that people and agents type as one
 * word: `run:r_3` for a Subscription Target, `session:<id>` for a holder. The
 * codec that parses the word is declared beside the field's schema and
 * attached to it as an annotation. A client that accepts the word only has to
 * find the codec and use it. The client never parses the word itself, and
 * never needs to know which operation it is serving.
 *
 * When the wire carries the word as it was typed, as a query string does, the
 * field's schema is the codec itself, and it is annotated with itself.
 */
import { Schema } from "effect";

/** The annotation key that holds the codec for a field's one-word form. */
const SHORTHAND = "shorthand";

/** Annotates a field's schema with the codec that parses the field's one-word form. */
export const markShorthand = <S extends Schema.Top>(
  schema: S,
  shorthand: Schema.Codec<S["Type"], string>,
): S => schema.annotate({ [SHORTHAND]: shorthand }) as S;

/**
 * Annotates a schema that is already the codec for the word with itself. Used
 * for fields whose wire form is the typed word, such as query string fields,
 * so a caller finds the codec in the same place as for every other shorthand.
 */
export const markShorthandOnItself = <S extends Schema.Codec<unknown, string>>(schema: S): S =>
  markShorthand(schema, schema as unknown as Schema.Codec<S["Type"], string>);

/**
 * Returns a function that decodes a typed word with the codec annotated on a
 * field's schema. Returns `undefined` when the field has no codec, which means
 * the typed text is the value as is.
 *
 * The returned function throws the codec's own error for an invalid word, so
 * the user sees the codec's message and not a second message about the same
 * word.
 */
export const readShorthandDecoder = (field: unknown): ((text: string) => unknown) | undefined => {
  const marked = (
    field as { readonly ast?: { readonly annotations?: Record<string, unknown> } } | undefined
  )?.ast?.annotations?.[SHORTHAND];
  if (marked === undefined) return undefined;
  const decode = Schema.decodeSync(marked as Schema.Codec<unknown, string>);
  return (text: string): unknown => decode(text);
};
