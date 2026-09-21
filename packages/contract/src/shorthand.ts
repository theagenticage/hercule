/**
 * A field written as one token.
 *
 * Some fields hold a structured value that a person and an agent type as one
 * word: `run:r_3` for a Subscription Target, `session:<id>` for a holder. The
 * codec that reads that word is declared beside the field's own schema and
 * marked on it, so a client that takes the word only has to find the codec and
 * use it. It never parses the word itself, and it never has to know which
 * operation it is serving.
 *
 * Where the wire carries the word as it was written - a query string does -
 * the field's schema is that codec, and it is marked with itself.
 */
import { Schema } from "effect";

/** The annotation a marked field carries: the codec that reads its one word. */
const SHORTHAND = "shorthand";

/** Marks a field's schema with the codec that reads one written word into it. */
export const markShorthand = <S extends Schema.Top>(
  schema: S,
  shorthand: Schema.Codec<S["Type"], string>,
): S => schema.annotate({ [SHORTHAND]: shorthand }) as S;

/**
 * Decodes one written word with the codec a field's schema carries, or
 * `undefined` for a field whose written text is its value.
 *
 * The decoder throws what the codec refuses with, so the writer reads the
 * codec's own message and no second message about the same word exists.
 */
export const readShorthandDecoder = (field: unknown): ((text: string) => unknown) | undefined => {
  const marked = (
    field as { readonly ast?: { readonly annotations?: Record<string, unknown> } } | undefined
  )?.ast?.annotations?.[SHORTHAND];
  if (marked === undefined) return undefined;
  const decode = Schema.decodeSync(marked as Schema.Codec<unknown, string>);
  return (text: string): unknown => decode(text);
};
