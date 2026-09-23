/**
 * Converts the Effect schemas that contributions declare (an event kind's
 * payload, a workflow action's input and output) to the JSON Schema stored in
 * the catalog.
 */
import type * as JsonSchema from "effect/JsonSchema";
import * as Schema from "effect/Schema";

/** The prefix of a `$ref` that points into a document's `$defs`. */
const DEFINITIONS_POINTER = "#/$defs/";

/** Checks whether a JSON value contains a `$ref` to `pointer`, at any depth. */
const containsReferenceTo = (value: unknown, pointer: string): boolean => {
  if (Array.isArray(value)) return value.some((item) => containsReferenceTo(item, pointer));
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(
    ([key, item]) => (key === "$ref" && item === pointer) || containsReferenceTo(item, pointer),
  );
};

/**
 * Converts a schema to a single JSON Schema object, with its definitions
 * under `$defs`.
 *
 * The definitions must be kept: Effect emits a schema that has an identifier
 * once, as a definition, and refers to it with a `$ref`. The root alone would
 * contain references that a reader cannot resolve.
 *
 * If the root itself is such a `$ref`, it is replaced by the definition it
 * points to, so a reader finds keywords like `type` and `properties` at the
 * top. That definition is then dropped from `$defs`, unless something still
 * refers to it (a recursive schema).
 */
export const deriveCatalogJsonSchema = (schema: Schema.Top): JsonSchema.JsonSchema => {
  const document = Schema.toJsonSchemaDocument(schema);
  const pointer = document.schema["$ref"];
  const rootDefinitionName =
    typeof pointer === "string" && pointer.startsWith(DEFINITIONS_POINTER)
      ? pointer.slice(DEFINITIONS_POINTER.length)
      : undefined;
  if (
    rootDefinitionName === undefined ||
    !Object.hasOwn(document.definitions, rootDefinitionName)
  ) {
    return Object.keys(document.definitions).length === 0
      ? document.schema
      : { ...document.schema, $defs: document.definitions };
  }
  const root = document.definitions[rootDefinitionName]!;
  const others = Object.fromEntries(
    Object.entries(document.definitions).filter(([name]) => name !== rootDefinitionName),
  );
  const definitions = containsReferenceTo(
    [root, others],
    `${DEFINITIONS_POINTER}${rootDefinitionName}`,
  )
    ? document.definitions
    : others;
  return Object.keys(definitions).length === 0 ? root : { ...root, $defs: definitions };
};
