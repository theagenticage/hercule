import { Effect, JsonSchema, Result, Schema, SchemaAST } from "effect";

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

/**
 * A config field whose value is a credential. It is never stored in the
 * instance's config: it goes to the secrets table under the instance's own
 * owner, is entered through a masked form, and is never read back. Only a
 * string can be one, because that is the only field the form can mask.
 */
export const secret = (words: {
  readonly title: string;
  readonly description: string;
}): Schema.String => Schema.String.annotate({ ...words, secret: true });

/** What the derived JSON schema marks such a property with. */
const SECRET_MARKER = "x-secret";

/** An annotation is declared as `unknown`, so each one is read at its own type. */
const said = (ast: SchemaAST.AST, word: "title" | "description"): string | undefined => {
  const value = ast.annotations?.[word];
  return typeof value === "string" ? value : undefined;
};

/**
 * A schema that carries a refinement - `Schema.Finite` is one - takes an
 * annotation on that refinement rather than on itself.
 */
const isSecret = (ast: SchemaAST.AST): boolean =>
  ast.annotations?.secret === true ||
  (ast.checks ?? []).some((check) => check.annotations?.secret === true);

/**
 * The fields a plugin marked secret, in its own words: what the UI asks for one
 * with, and what the controller keeps out of the stored config.
 *
 * Read off the schema rather than off its JSON Schema, because the derivation
 * drops an annotation it does not know - which is also why the marker is put
 * back by hand below.
 */
export const secretFields = (
  schema: Schema.Top,
): ReadonlyArray<{
  readonly name: string;
  readonly title: string;
  readonly description: string;
}> => {
  // `Objects` is the node a struct derives to; anything else has no named
  // properties to mark, and `configJsonSchema` refuses it separately.
  if (!SchemaAST.isObjects(schema.ast)) return [];
  return schema.ast.propertySignatures.flatMap(({ name, type }) => {
    if (typeof name !== "string" || !isSecret(type)) return [];
    return [
      {
        name,
        title: said(type, "title") ?? name,
        description: said(type, "description") ?? "",
      },
    ];
  });
};

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

  const marked = new Set(secretFields(schema).map((field) => field.name));
  const rendered: Record<string, JsonSchema.JsonSchema> = {};
  for (const [name, property] of Object.entries(properties)) {
    const reason = marked.has(name)
      ? property.type === "string"
        ? undefined
        : "is marked secret, which only a string can be: nothing else has a masked input"
      : unsupportedProperty(property);
    if (reason !== undefined) {
      return Result.fail(
        new UnsupportedConfigSchema({ message: `the config property "${name}" ${reason}` }),
      );
    }
    rendered[name] = marked.has(name) ? { ...property, [SECRET_MARKER]: true } : property;
  }

  // A secret-marked field is not part of the config at all: its value lives in
  // the secrets table, so a config without it is complete.
  const required = root.required as ReadonlyArray<string> | undefined;

  return Result.succeed({
    ...root,
    properties: rendered,
    ...(required === undefined ? {} : { required: required.filter((name) => !marked.has(name)) }),
  });
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

/**
 * The same schema with every secret-marked field taken out of it: what a stored
 * config is read against, so a config is complete without a credential in it
 * and a credential written into one is refused by name rather than saved.
 */
export const withoutSecrets = (schema: Schema.Top): Schema.Top => {
  const marked = new Set(secretFields(schema).map((field) => field.name));
  if (marked.size === 0) return schema;
  // `fields` is public on `Schema.Struct` but not on `Schema.Top`, which is
  // what a plugin's config schema arrives as, and effect 4.0.0-rc.112 exports
  // no guard that narrows one to the other; the struct AST above has already
  // said this is a struct. Rebuilding drops the struct's own annotations, which
  // nothing reads: the result is only ever decoded against.
  const fields = (schema as unknown as { readonly fields: Record<string, Schema.Top> }).fields;
  return Schema.Struct(
    Object.fromEntries(Object.entries(fields).filter(([name]) => !marked.has(name))),
  );
};
