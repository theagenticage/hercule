import { Effect, JsonSchema, Result, Schema } from "effect";

/**
 * A config schema the generated settings form cannot render. Carries the reason
 * as prose because the plugin author is the only reader: the form supports one
 * flat object of scalars, and every refusal names the property that broke it.
 */
export class UnsupportedConfigSchema extends Schema.TaggedError<UnsupportedConfigSchema>()(
  "UnsupportedConfigSchema",
  { message: Schema.String },
) {}

/**
 * effect derives a struct with no properties as "an object or an array" rather
 * than as an empty object schema. A plugin with nothing to configure is the
 * ordinary case, so that one shape is normalised instead of refused.
 */
const EMPTY_OBJECT = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
} as const;

/** A branch that says a type and nothing else, as an empty struct's two do. */
const isBareType = (branch: unknown, type: string) => {
  const keys = Object.keys(branch as object);
  return keys.length === 1 && (branch as JsonSchema.JsonSchema).type === type;
};

const derivesAsEmptyStruct = (root: JsonSchema.JsonSchema): boolean => {
  const branches = root.anyOf;
  if (!Array.isArray(branches) || branches.length !== 2) return false;
  return (
    branches.some((branch) => isBareType(branch, "object")) &&
    branches.some((branch) => isBareType(branch, "array"))
  );
};

/** Why one property cannot be rendered, or `undefined` when it can. */
const unsupportedProperty = (property: JsonSchema.JsonSchema): string | undefined => {
  // A select renders string options; a number or boolean enum would need a
  // widget that does not exist.
  if ("enum" in property && property.type !== "string") {
    return "is an enum of something other than strings";
  }
  switch (property.type) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
      return undefined;
    case "array": {
      const items = property.items as JsonSchema.JsonSchema | undefined;
      return items?.type === "string" ? undefined : "is a list of something other than strings";
    }
    case "object":
      return "is a nested object";
    default:
      // No `type` at all is what a union derives to, which is how
      // `Schema.Number` (Infinity and NaN as strings) and `Schema.optional`
      // (a null branch) arrive here. `Schema.Finite` and `Schema.optionalKey`
      // are the shapes that work.
      return "is not a string, number, integer, boolean, enum or list of strings";
  }
};

/**
 * The JSON Schema the catalog persists and the web app builds a form from, or a
 * refusal. Only a flat object of scalars renders, so anything deeper is caught
 * here, at load, rather than as an unrenderable form later.
 */
export const configJsonSchema = (
  schema: Schema.Top,
): Result.Result<JsonSchema.JsonSchema, UnsupportedConfigSchema> => {
  const root = Schema.toJsonSchemaDocument(schema).schema;

  if (derivesAsEmptyStruct(root)) return Result.succeed(EMPTY_OBJECT);

  const properties = root.properties as Record<string, JsonSchema.JsonSchema> | undefined;
  if (root.type !== "object" || properties === undefined) {
    return Result.fail(
      new UnsupportedConfigSchema({
        message:
          "a plugin config schema must be an object with named properties: no open maps, no references",
      }),
    );
  }

  for (const [name, property] of Object.entries(properties)) {
    const reason = unsupportedProperty(property);
    if (reason !== undefined) {
      return Result.fail(
        new UnsupportedConfigSchema({ message: `the config property "${name}" ${reason}` }),
      );
    }
  }

  return Result.succeed(root);
};

/**
 * A stored config read against the live schema the plugin authored: every issue
 * at once, so a form can put each message under its own field, and an unknown
 * key refused rather than dropped, so a stale field is said out loud.
 *
 * The schema crosses the boundary opaque, so what comes back is `unknown` until
 * the plugin's own hook is handed it.
 */
export const decodeAgainst = (
  schema: Schema.Top,
  config: Schema.Json,
): Effect.Effect<unknown, Schema.SchemaError> =>
  Schema.decodeUnknownEffect(schema as Schema.Codec<unknown>, {
    errors: "all",
    onExcessProperty: "error",
  })(config);
