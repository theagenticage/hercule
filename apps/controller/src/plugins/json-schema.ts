/**
 * The JSON Schema the catalog holds for a schema that a contribution declares:
 * an event kind's payload, or a workflow action's input and output.
 */
import type * as JsonSchema from "effect/JsonSchema";
import * as Schema from "effect/Schema";

/** Where the definitions of a derived document are pointed at from. */
const DEFINITIONS_POINTER = "#/$defs/";

/** Whether a JSON value holds a `$ref` to this pointer, at any depth. */
const holdsReferenceTo = (value: unknown, pointer: string): boolean => {
  if (Array.isArray(value)) return value.some((item) => holdsReferenceTo(item, pointer));
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(
    ([key, item]) => (key === "$ref" && item === pointer) || holdsReferenceTo(item, pointer),
  );
};

/**
 * The derived document as one JSON Schema. It is a whole document rather than
 * the root node alone: a schema carrying an identifier is emitted once as a
 * definition and pointed at with a `$ref`, and a reader handed the root by
 * itself could not follow that reference.
 *
 * A root that is such a reference is replaced by the definition it points at,
 * so a reader finds the root's own keywords, such as `type` and `properties`,
 * at the top. That definition then stays among the definitions only where a
 * reference still points at it, as in a schema that contains itself.
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
  const definitions = holdsReferenceTo(
    [root, others],
    `${DEFINITIONS_POINTER}${rootDefinitionName}`,
  )
    ? document.definitions
    : others;
  return Object.keys(definitions).length === 0 ? root : { ...root, $defs: definitions };
};
