/**
 * A struct that rejects unknown keys, in the schema itself, as `settings.update`
 * needs.
 *
 * Rejecting an unknown key is a decoding option, `onExcessProperty: "error"`,
 * and the transport never sets it: `HttpApiBuilder` decodes every payload with
 * `Schema.decodeUnknownEffect(schema)` and no options, and Effect 4 carries the
 * option nowhere in the AST, so no annotation can express it. A payload that
 * must reject unknown keys therefore has to say so in its own shape.
 *
 * The shape is a struct plus one index signature over the keys the struct does
 * not declare, whose value type is `never`: a key nobody declared has no value
 * that decodes, so the decode fails with an issue pointing at that key. The
 * index signature would also poison the decoded TypeScript type - an
 * intersection with `{ readonly [x: string]: never }` is a type no object
 * literal satisfies - so the closed shape is the encoded side only, and the
 * decoded side is the plain struct. Callers get the clean type; the wire gets
 * the closed one.
 */
import { Schema, SchemaGetter } from "effect";

/** The same fields, every one of them optional. */
export type Optional<Fields extends Schema.Struct.Fields> = {
  readonly [K in keyof Fields]: Schema.optionalKey<Fields[K]>;
};

/**
 * Makes every field of a key map optional, so one declaration of a scope's keys
 * serves both the full object and a partial write over it.
 */
export const optional = <const Fields extends Schema.Struct.Fields>(
  fields: Fields,
): Optional<Fields> =>
  Object.fromEntries(
    Object.entries(fields).map(([key, schema]) => [key, Schema.optionalKey(schema)]),
  ) as Optional<Fields>;

/** A struct whose decoding fails on any key it does not declare. */
export const closedStruct = <const Fields extends Schema.Struct.Fields>(fields: Fields) => {
  const declared = new Set(Object.keys(fields));
  const undeclared = Schema.String.check(
    Schema.makeFilter((key: string) => (declared.has(key) ? "a key the schema declares" : true), {
      title: "a key the schema does not declare",
    }),
  );
  const struct = Schema.Struct(fields);
  // The error is reported at the key's own path, so the message does not need to include the key.
  const undeclaredKeyValue = Schema.Never.annotate({
    message: "This field is not known here. Correct its name, or remove it.",
  });
  return Schema.StructWithRest(struct, [Schema.Record(undeclared, undeclaredKeyValue)]).pipe(
    Schema.decodeTo(struct, {
      decode: SchemaGetter.passthrough({ strict: false }),
      encode: SchemaGetter.passthrough({ strict: false }),
    }),
  );
};
