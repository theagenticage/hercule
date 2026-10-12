/**
 * A struct that rejects unknown keys, and a record that rejects keys its key
 * schema refuses, in the schema itself.
 *
 * The struct is what `settings.update` needs.
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
import { Result, Schema, SchemaGetter, SchemaParser } from "effect";

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

/**
 * A record whose decoding fails on a key that `key` refuses, with the issue
 * `key` reports at that key's path.
 *
 * `Schema.Record(key, value)` does not fail on such a key: it drops the entry
 * and decodes the rest. A request with one malformed key would then succeed as
 * if that entry had never been sent. So the record takes any string as its key
 * and checks each key with `key` afterwards.
 */
export const closedRecord = <V extends Schema.Top>(key: Schema.Codec<string, string>, value: V) => {
  const decodeKey = SchemaParser.decodeUnknownResult(key);
  return Schema.Record(Schema.String, value).check(
    Schema.makeFilter((record: { readonly [name: string]: unknown }) => {
      for (const name of Object.keys(record)) {
        const decoded = decodeKey(name);
        if (Result.isFailure(decoded)) return { path: [name], issue: decoded.failure };
      }
      return undefined;
    }),
  );
};
