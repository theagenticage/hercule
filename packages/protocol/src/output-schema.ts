/**
 * The output schema a session answers under, and the closed subset it may be
 * written in.
 *
 * One schema has to mean the same thing on every harness, and the three of them
 * agree on a small common core only: OpenAI's strict mode, draft-07 and pi's
 * strict transform each refuse or silently reshape different things outside it.
 * So the subset is a closed keyword set rather than a best effort, and the lint
 * below is the one place that says what is in it. The controller runs it when a
 * session is spawned and the runner runs it again at session start, because the
 * two are different processes and only the schema itself crosses between them.
 */
import { Schema } from "effect";

/**
 * A JSON Schema document, as it travels: the controller stores and forwards it
 * byte for byte, and only `lintOutputSchema` reads inside it.
 */
export const OutputSchema = Schema.Record(Schema.String, Schema.Json);

export type OutputSchema = Schema.Schema.Type<typeof OutputSchema>;

/**
 * Every keyword the subset allows, and what it may sit on: `object` and
 * `array` keywords say nothing anywhere else, so a `properties` on a string
 * node is a rule that would never be applied rather than one to ignore.
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

/** The one dialect the subset is written in. */
const DRAFT_07 = "http://json-schema.org/draft-07/schema#";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A key as one step of a JSON Pointer, with the two characters a pointer escapes. */
const step = (key: string): string => key.replace(/~/g, "~0").replace(/\//g, "~1");

/** The pointer to a child of `path`, whose root is spelled `/`. */
const under = (path: string, ...keys: ReadonlyArray<string>): string =>
  `${path === "/" ? "" : path}/${keys.map(step).join("/")}`;

/**
 * The type a node declares, once `["<type>", "null"]` - the one way the subset
 * spells nullable - is read as the type it makes nullable. `undefined` means
 * the node declares no type the subset recognizes.
 */
const typeOf = (node: Record<string, unknown>): string | undefined => {
  const declared = node["type"];
  if (typeof declared === "string") return TYPES.has(declared) ? declared : undefined;
  if (!Array.isArray(declared) || declared.length !== 2) return undefined;
  const pair = declared as ReadonlyArray<unknown>;
  const [first, second] = pair;
  if (second !== "null" || typeof first !== "string") return undefined;
  return TYPES.has(first) && first !== "null" ? first : undefined;
};

const isEnumValue = (value: unknown): boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/**
 * Whether the node's declared type could hold this value. A fixed value of
 * another type is a branch of the schema nothing can ever satisfy, which is
 * the mistake worth catching before a harness is held to it.
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
    // An object or an array named value by value is outside the subset, and
    // `null` is spelled by the nullable type rather than by a value.
    default:
      return false;
  }
};

/** One value as a message says it back. */
const said = (value: unknown): string => JSON.stringify(value) ?? String(value);

/**
 * Every issue with one node and everything below it. A node is reported at
 * most once, and a node the walk cannot make sense of is not walked into: one
 * mistake reads as one issue rather than as the cascade it would otherwise
 * cause further down.
 */
const issuesIn = (node: unknown, path: string, isRoot: boolean): ReadonlyArray<string> => {
  if (!isRecord(node)) return [`${path}: a schema node must be an object`];

  const dialect = node["$schema"];
  if (dialect !== undefined && dialect !== DRAFT_07) {
    return [`${path}: $schema must be ${DRAFT_07}`];
  }

  // `Object.hasOwn`, not a lookup: `constructor` and `__proto__` answer off
  // the prototype of a plain object, and both would read as keywords.
  const foreign = Object.keys(node).find((key) => !Object.hasOwn(KEYWORDS, key));
  if (foreign !== undefined) return [`${path}: the keyword ${foreign} is outside the subset`];

  const type = typeOf(node);
  if (type === undefined) {
    return [
      `${path}: type must be one of ${[...TYPES].join(", ")}, ` +
        `or a two-element array of one of those and "null"`,
    ];
  }
  // The root is the object the harness answers with; nullable, it would let a
  // turn answer `null` and satisfy the schema while saying nothing.
  if (isRoot && node["type"] !== "object") return ["/: the root must be type object"];

  const misplaced = Object.keys(node).find((key) => {
    const scope = KEYWORDS[key];
    return scope !== "any" && scope !== type;
  });
  if (misplaced !== undefined) {
    return [`${path}: the keyword ${misplaced} says nothing on a ${type}`];
  }

  const values = node["enum"];
  if (values !== undefined && (!Array.isArray(values) || values.length === 0)) {
    return [`${path}: enum must be a non-empty array`];
  }
  if (Array.isArray(values) && !values.every(isEnumValue)) {
    return [`${path}: enum must hold strings, numbers or booleans only`];
  }
  const fixed: ReadonlyArray<unknown> = Array.isArray(values)
    ? values
    : Object.hasOwn(node, "const")
      ? [node["const"]]
      : [];
  const mismatched = fixed.find((value) => !holdsValue(type, value));
  if (mismatched !== undefined) {
    return [`${path}: ${said(mismatched)} is not a ${type}`];
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
      return [`${path}: required holds ${said(notAKey)}, which is not a property name`];
    }
    // Both ways round: every property required, and nothing required that the
    // object does not have. A required key with no property is a document no
    // value can satisfy, which is the same mistake as an optional field.
    const unknown = entries.find((entry) => !Object.hasOwn(properties, entry as string));
    if (unknown !== undefined) {
      return [`${path}: required names ${said(unknown)}, which is not one of its properties`];
    }
    const missing = Object.keys(properties).find((key) => !required.includes(key));
    if (missing !== undefined) {
      return [`${path}: required must list every property; ${missing} is not in it`];
    }
    return Object.entries(properties).flatMap(([key, child]) =>
      issuesIn(child, under(path, "properties", key), false),
    );
  }

  if (type === "array") {
    const items = node["items"];
    if (items === undefined) return [`${path}: an array needs items`];
    return issuesIn(items, under(path, "items"), false);
  }

  return [];
};

/**
 * What a schema breaks in the subset, one issue per mistake, each naming where
 * it is as a JSON Pointer and what rule it broke. An empty answer is the
 * schema accepted.
 */
export const lintOutputSchema = (schema: unknown): ReadonlyArray<string> =>
  issuesIn(schema, "/", true);
