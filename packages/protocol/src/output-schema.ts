/**
 * The output schema a session's turns must match, and the closed subset of JSON
 * Schema it may be written in.
 *
 * One schema must mean the same thing on every harness, and the three harnesses
 * agree on a small common core only. Outside that core, OpenAI's strict mode,
 * draft-07 and pi's strict transform each reject or silently change different
 * things. So the subset is a closed set of keywords, not a best effort, and
 * `lintOutputSchema` below is the only place that defines what is in the set.
 * The controller runs the lint when a session is spawned, and the runner runs
 * it again at session start, because the two are different processes and only
 * the schema crosses between them.
 */
import { Schema } from "effect";

/**
 * The longest output schema, measured as the JSON the schema travels as.
 *
 * The schema is text the caller controls. It is stored on the session row, sent
 * over the runner socket and, on pi, given to the harness in an environment
 * variable. An environment has a size a process cannot start past, so without a
 * bound a large schema would fail at launch instead of at the call that sent
 * it. 32 KiB is far more than the strict subset needs for any result a turn can
 * return, and well under what each of the three harnesses accepts, so the
 * limit rejects nothing anyone would write on purpose. The limit is part of
 * the schema itself, so both sides enforce it: the controller before it writes
 * a row, the runner before it starts a harness.
 */
export const MAX_OUTPUT_SCHEMA_LENGTH = 32 * 1024;

/**
 * The maximum nesting depth, in objects and arrays, of a JSON value a caller
 * sends. A JSON Schema needs two levels for each nested object, so 32 is far
 * more than a person writes. The limit keeps values far below the depth at
 * which a recursive function, such as `JSON.stringify`, overflows the call
 * stack.
 */
export const MAX_JSON_DEPTH = 32;

/**
 * Checks whether a JSON value nests objects and arrays at most `levels` deep.
 * The check stops at the limit, so a very deep value costs no more to check
 * than one at the limit.
 */
export const isNestedWithin = (value: unknown, levels: number): boolean =>
  typeof value !== "object" ||
  value === null ||
  (levels > 0 && Object.values(value).every((child) => isNestedWithin(child, levels - 1)));

/**
 * A JSON Schema document, as it travels. The controller stores and forwards it
 * byte for byte. Only `lintOutputSchema` reads inside it.
 *
 * The depth is checked before the length. The length is measured with
 * `JSON.stringify`, which recurses once per level, so a deep enough schema
 * would overflow the call stack before its length is known.
 */
export const OutputSchema = Schema.Record(Schema.String, Schema.Json).check(
  Schema.makeFilter((schema) =>
    !isNestedWithin(schema, MAX_JSON_DEPTH)
      ? `an output schema can nest objects and arrays at most ${String(MAX_JSON_DEPTH)} levels deep`
      : JSON.stringify(schema).length > MAX_OUTPUT_SCHEMA_LENGTH
        ? `an output schema can be at most ${String(MAX_OUTPUT_SCHEMA_LENGTH)} characters of JSON`
        : undefined,
  ),
);

export type OutputSchema = Schema.Schema.Type<typeof OutputSchema>;

/**
 * Every keyword the subset allows, and which node type the keyword may be used
 * on. An `object` keyword and an `array` keyword have no effect on any other
 * type, so `properties` on a string node is a rule that would never apply.
 * Such a rule is rejected, not ignored.
 */
const KEYWORDS: Record<string, "any" | "object" | "array"> = {
  $schema: "any",
  type: "any",
  enum: "any",
  const: "any",
  title: "any",
  description: "any",
  properties: "object",
  required: "object",
  additionalProperties: "object",
  items: "array",
};

/** The only types a node may declare. */
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

/** The only JSON Schema dialect the subset accepts. */
const DRAFT_07 = "http://json-schema.org/draft-07/schema#";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Escapes a key as one segment of a JSON Pointer, which escapes `~` and `/`. */
const escapePointerStep = (key: string): string => key.replace(/~/g, "~0").replace(/\//g, "~1");

/** Builds the pointer to a child of `path`. The root path is written `/`. */
const buildPointer = (path: string, ...keys: ReadonlyArray<string>): string =>
  `${path === "/" ? "" : path}/${keys.map(escapePointerStep).join("/")}`;

/**
 * Reads the type a node declares. The subset writes a nullable type as
 * `["<type>", "null"]`, and that form is read as the type it makes nullable.
 * Returns `undefined` when the node declares no type the subset recognizes.
 */
const readDeclaredType = (node: Record<string, unknown>): string | undefined => {
  const declared = node["type"];
  if (typeof declared === "string") return TYPES.has(declared) ? declared : undefined;
  if (!Array.isArray(declared) || declared.length !== 2) return undefined;
  const [named, nullable] = declared as ReadonlyArray<unknown>;
  if (nullable !== "null" || typeof named !== "string") return undefined;
  return TYPES.has(named) && named !== "null" ? named : undefined;
};

const isEnumValue = (value: unknown): boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/**
 * Checks whether the node's declared type can hold this value. A fixed value
 * of another type is a branch of the schema that nothing can satisfy, and that
 * mistake is worth catching before a harness has to follow the schema.
 */
const holdsValue = (type: string, value: unknown): boolean => {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    // An object or an array as a fixed value is outside the subset, and `null`
    // is written with the nullable type rather than as a value.
    default:
      return false;
  }
};

/** Quotes one value for an error message. */
const quoteValue = (value: unknown): string => JSON.stringify(value) ?? String(value);

/**
 * Lints one node and everything below it, and returns every issue it finds. A
 * node is reported at most once, and the lint does not descend into a node it
 * cannot read. So one mistake is reported as one issue, and not as the
 * cascade of issues it would otherwise cause below.
 */
const lintNode = (node: unknown, path: string, isRoot: boolean): ReadonlyArray<string> => {
  if (!isRecord(node)) return [`${path}: a schema node must be an object`];

  const dialect = node["$schema"];
  if (dialect !== undefined && dialect !== DRAFT_07) {
    return [`${path}: $schema must be ${DRAFT_07}`];
  }

  // `Object.hasOwn`, and not a plain lookup. A plain object returns
  // `constructor` and `__proto__` from its prototype, so a lookup would treat
  // both of those as keywords.
  const foreignKeyword = Object.keys(node).find((key) => !Object.hasOwn(KEYWORDS, key));
  if (foreignKeyword !== undefined) {
    return [`${path}: the keyword ${foreignKeyword} is outside the subset`];
  }

  const type = readDeclaredType(node);
  if (type === undefined) {
    return [
      `${path}: type must be one of ${[...TYPES].join(", ")}, ` +
        `or a two-element array of one of those and "null"`,
    ];
  }
  // The root is the object the harness returns. A nullable root would let a
  // turn return `null`, which satisfies the schema but carries no result.
  if (isRoot && node["type"] !== "object") return ["/: the root must be type object"];

  const misplacedKeyword = Object.keys(node).find((key) => {
    const scope = KEYWORDS[key];
    return scope !== "any" && scope !== type;
  });
  if (misplacedKeyword !== undefined) {
    return [`${path}: the keyword ${misplacedKeyword} has no effect on a ${type}`];
  }

  const values = node["enum"];
  if (values !== undefined && (!Array.isArray(values) || values.length === 0)) {
    return [`${path}: enum must be a non-empty array`];
  }
  if (Array.isArray(values) && !values.every(isEnumValue)) {
    return [`${path}: enum must hold strings, numbers or booleans only`];
  }
  // Both of them, not one or the other. A node that carries `enum` and `const`
  // together must hold its declared type in each of them, and a check of the
  // enum alone would let a `const` of the wrong type through.
  const enumValues: ReadonlyArray<unknown> = Array.isArray(values) ? values : [];
  const fixedValues: ReadonlyArray<unknown> = Object.hasOwn(node, "const")
    ? [...enumValues, node["const"]]
    : enumValues;
  const mismatchedValue = fixedValues.find((value) => !holdsValue(type, value));
  if (mismatchedValue !== undefined) {
    return [`${path}: ${quoteValue(mismatchedValue)} is not a ${type}`];
  }

  if (type === "object") {
    if (node["additionalProperties"] !== false) {
      return [`${path}: an object needs additionalProperties: false`];
    }
    const properties = node["properties"];
    if (!isRecord(properties)) return [`${path}: an object needs properties`];
    const required = node["required"];
    if (!Array.isArray(required)) return [`${path}: an object needs required`];
    const entries: ReadonlyArray<unknown> = required;
    const notAKey = entries.find((entry) => typeof entry !== "string");
    if (notAKey !== undefined) {
      return [`${path}: required holds ${quoteValue(notAKey)}, which is not a property name`];
    }
    // The check runs both ways: every property is required, and nothing is
    // required that the object does not have. A required key with no property
    // makes a schema no value can satisfy.
    const requiredWithoutProperty = entries.find(
      (entry) => !Object.hasOwn(properties, entry as string),
    );
    if (requiredWithoutProperty !== undefined) {
      return [
        `${path}: required lists ${quoteValue(requiredWithoutProperty)}, ` +
          "which is not one of its properties",
      ];
    }
    const propertyNotRequired = Object.keys(properties).find((key) => !required.includes(key));
    if (propertyNotRequired !== undefined) {
      return [`${path}: required must list every property; ${propertyNotRequired} is not in it`];
    }
    return Object.entries(properties).flatMap(([key, child]) =>
      lintNode(child, buildPointer(path, "properties", key), false),
    );
  }

  if (type === "array") {
    const items = node["items"];
    if (items === undefined) return [`${path}: an array needs items`];
    return lintNode(items, buildPointer(path, "items"), false);
  }

  return [];
};

/**
 * Lints a schema against the subset. Returns one issue per mistake. Each issue
 * gives where the mistake is, as a JSON Pointer, and which rule it broke. An
 * empty list means the schema is accepted.
 */
export const lintOutputSchema = (schema: unknown): ReadonlyArray<string> =>
  lintNode(schema, "/", true);
