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
 * Effect derives a struct with no properties as "anything but null" rather
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

/**
 * The key the derived JSON Schema uses to mark a property whose choices load
 * from the external account. A plugin author writes
 * `Schema.String.annotate({ choices: true })` or
 * `Schema.Array(Schema.String).annotate({ choices: true })`.
 */
const CHOICES_MARKER = "x-choices";

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
const isMarkedSecret = (ast: SchemaAST.AST): boolean =>
  ast.annotations?.secret === true ||
  (ast.checks ?? []).some((check) => check.annotations?.secret === true);

/**
 * Checks whether a field is marked `choices: true`. Like `isMarkedSecret`, it also
 * looks at the schema's refinements, which is where an annotation lands on a
 * schema such as `Schema.String.check(...)`.
 */
const isMarkedChoices = (ast: SchemaAST.AST): boolean =>
  ast.annotations?.choices === true ||
  (ast.checks ?? []).some((check) => check.annotations?.choices === true);

/**
 * Lists the names of the fields a plugin marked `choices: true`: the fields
 * whose choices the connection type loads from the external account. The
 * controller uses this to refuse a type that marks a field but has no
 * `listChoices`, and to refuse a request for the choices of any other field.
 *
 * Reads the schema rather than its JSON Schema, for the reason
 * `listSecretFields` gives.
 */
export const listChoiceFields = (schema: Schema.Top): ReadonlyArray<string> => {
  if (!SchemaAST.isObjects(schema.ast)) return [];
  return schema.ast.propertySignatures.flatMap(({ name, type }) =>
    typeof name === "string" && isMarkedChoices(type) ? [name] : [],
  );
};

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
    if (typeof name !== "string" || !isMarkedSecret(type)) return [];
    return [
      {
        name,
        title: readAnnotation(type, "title") ?? name,
        description: readAnnotation(type, "description") ?? "",
      },
    ];
  });
};

/**
 * Checks whether the derived root is the one Effect gives a struct with no
 * properties: a `not` keyword whose value is exactly `{ type: "null" }`. Other
 * keys on the root are not looked at.
 */
const derivesAsEmptyStruct = (root: JsonSchema.JsonSchema): boolean => {
  const excluded = root["not"] as JsonSchema.JsonSchema | undefined;
  return excluded?.type === "null" && Object.keys(excluded).length === 1;
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
 * Returns why a property cannot load its choices from the account, or
 * `undefined` when it can. Only a string or a list of strings can, because
 * the picker stores the chosen `value`, which is a string.
 */
const findUnsupportedChoicesReason = (property: JsonSchema.JsonSchema): string | undefined => {
  const items = property.items as JsonSchema.JsonSchema | undefined;
  const isStringList = property.type === "array" && items?.type === "string";
  return property.type === "string" || isStringList
    ? undefined
    : "is marked choices, which only a string or a list of strings can be";
};

/**
 * Returns why a property that loads its choices cannot be required, or
 * `undefined` when it is optional. The choices need working credentials, so the
 * setup form leaves the field out and a new Connection starts with it unset.
 * A required field would make that config invalid.
 */
const findRequiredChoicesReason = (
  name: string,
  required: ReadonlyArray<string>,
): string | undefined =>
  required.includes(name)
    ? "is marked choices, so it must be optional (Schema.optionalKey): a new Connection starts with it unset, and the type must work with it unset"
    : undefined;

/**
 * Derives the JSON Schema the catalog stores and the web app builds a form
 * from. Fails with `UnsupportedConfigSchema` when the form cannot render the
 * schema. Only a flat object of scalars renders, so anything deeper is caught
 * here, at load, rather than as an unrenderable form later.
 */
export const deriveConfigJsonSchema = (
  schema: Schema.Top,
): Result.Result<JsonSchema.JsonSchema, UnsupportedConfigSchema> => {
  const root = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" }).schema;

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
  const choiceFields = new Set(listChoiceFields(schema));
  const required = (root.required as ReadonlyArray<string> | undefined) ?? [];
  const rendered: Record<string, JsonSchema.JsonSchema> = {};
  for (const [name, property] of Object.entries(properties)) {
    const reason = marked.has(name)
      ? property.type === "string"
        ? undefined
        : "is marked secret, which only a string can be: nothing else has a masked input"
      : findUnsupportedReason(property);
    const failure =
      reason ??
      (choiceFields.has(name)
        ? (findUnsupportedChoicesReason(property) ?? findRequiredChoicesReason(name, required))
        : undefined);
    if (failure !== undefined) {
      return Result.fail(
        new UnsupportedConfigSchema({ message: `the config property "${name}" ${failure}` }),
      );
    }
    rendered[name] = {
      ...property,
      ...(marked.has(name) ? { [SECRET_MARKER]: true } : {}),
      ...(choiceFields.has(name) ? { [CHOICES_MARKER]: true } : {}),
    };
  }

  // A secret-marked field is not part of the config at all: its value lives in
  // the secrets table, so a config without it is complete.
  return Result.succeed({
    ...root,
    properties: rendered,
    ...(root.required === undefined
      ? {}
      : { required: required.filter((name) => !marked.has(name)) }),
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
