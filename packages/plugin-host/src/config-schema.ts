import { Effect, JsonSchema, Result, Schema, SchemaAST } from "effect";

/**
 * A config schema the generated settings form cannot render. The message
 * explains why in prose, because the plugin author is the only reader: the
 * form supports one flat object of scalars, and every message includes the
 * property that broke that rule.
 */
export class UnsupportedConfigSchema extends Schema.TaggedError<UnsupportedConfigSchema>()(
  "UnsupportedConfigSchema",
  { message: Schema.String },
) {}

/**
 * Effect derives a struct with no properties as "an object or an array" rather
 * than as an empty object schema. A plugin with nothing to configure is the
 * ordinary case, so that shape is converted to an empty object instead of
 * rejected.
 */
const EMPTY_OBJECT = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
} as const;

/**
 * Returns a string schema for a config field whose value is a credential. The
 * value is never stored in the instance's config: it goes to the secrets table
 * under the instance's own owner, is entered through a masked input, and is
 * never read back. Only a string field can be secret, because that is the only
 * field the form can mask.
 */
export const secret = (words: {
  readonly title: string;
  readonly description: string;
}): Schema.String => Schema.String.annotate({ ...words, secret: true });

/** The key the derived JSON Schema uses to mark a secret property. */
const SECRET_MARKER = "x-secret";

/** Reads a string annotation. Annotations are typed `unknown`, so the type is checked here. */
const readAnnotation = (ast: SchemaAST.AST, word: "title" | "description"): string | undefined => {
  const value = ast.annotations?.[word];
  return typeof value === "string" ? value : undefined;
};

/**
 * Checks whether a field is marked secret. A schema with a refinement - such
 * as `Schema.Finite` - has its annotation on that refinement rather than on
 * itself, so both places are checked.
 */
const isSecret = (ast: SchemaAST.AST): boolean =>
  ast.annotations?.secret === true ||
  (ast.checks ?? []).some((check) => check.annotations?.secret === true);

/**
 * Lists the fields a plugin marked secret, with the title and description the
 * plugin wrote. The UI uses these to ask for each secret, and the controller
 * keeps these fields out of the stored config.
 *
 * Reads the schema rather than its JSON Schema, because the derivation drops
 * annotations it does not know. That is also why `deriveConfigJsonSchema` adds
 * the marker back by hand.
 */
export const listSecretFields = (
  schema: Schema.Top,
): ReadonlyArray<{
  readonly name: string;
  readonly title: string;
  readonly description: string;
}> => {
  // `Objects` is the AST node of a struct; anything else has no named
  // properties to mark, and `deriveConfigJsonSchema` rejects it separately.
  if (!SchemaAST.isObjects(schema.ast)) return [];
  return schema.ast.propertySignatures.flatMap(({ name, type }) => {
    if (typeof name !== "string" || !isSecret(type)) return [];
    return [
      {
        name,
        title: readAnnotation(type, "title") ?? name,
        description: readAnnotation(type, "description") ?? "",
      },
    ];
  });
};

/** Checks whether a branch has only a `type` key with the given type, as both branches of an empty struct do. */
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

/** Returns why one property cannot be rendered, or `undefined` when it can. */
const findUnsupportedReason = (property: JsonSchema.JsonSchema): string | undefined => {
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
 * Derives the JSON Schema the catalog stores and the web app builds a form
 * from. Fails with `UnsupportedConfigSchema` when the form cannot render the
 * schema. Only a flat object of scalars renders, so anything deeper is caught
 * here, at load, rather than as an unrenderable form later.
 */
export const deriveConfigJsonSchema = (
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

  const marked = new Set(listSecretFields(schema).map((field) => field.name));
  const rendered: Record<string, JsonSchema.JsonSchema> = {};
  for (const [name, property] of Object.entries(properties)) {
    const reason = marked.has(name)
      ? property.type === "string"
        ? undefined
        : "is marked secret, which only a string can be: nothing else has a masked input"
      : findUnsupportedReason(property);
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
 * Decodes a stored config with the live schema the plugin wrote. Reports every
 * issue at once, so a form can show each message under its own field, and
 * rejects an unknown key rather than dropping it, so a stale field is reported
 * rather than ignored.
 *
 * The schema's type is not known here, so the result is `unknown` until it is
 * passed to the plugin's own hook.
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
 * Returns the same schema with every secret field removed. A stored config is
 * decoded with this schema, so a config is complete without a credential in
 * it, and a credential written into one is rejected by name rather than
 * saved.
 */
export const excludeSecretFields = (schema: Schema.Top): Schema.Top => {
  const marked = new Set(listSecretFields(schema).map((field) => field.name));
  if (marked.size === 0) return schema;
  // `fields` is public on `Schema.Struct` but not on `Schema.Top`, which is
  // what a plugin's config schema arrives as, and effect 4.0.0-rc.112 exports
  // no guard that narrows one to the other; `listSecretFields` has already
  // checked that the AST is a struct. Rebuilding drops the struct's own
  // annotations, which nothing reads: the result is only used for decoding.
  const fields = (schema as unknown as { readonly fields: Record<string, Schema.Top> }).fields;
  return Schema.Struct(
    Object.fromEntries(Object.entries(fields).filter(([name]) => !marked.has(name))),
  );
};
