/**
 * The output-schema subset: what a schema may say if one schema is to mean the
 * same thing on all three harnesses.
 *
 * The lint answers issues, never a boolean: each case below names the one
 * thing wrong with an otherwise acceptable schema, and asserts the lint says
 * where it is and what rule it broke. A schema the lint accepts is the whole
 * subset in one document, so "accepted" is not proven by the trivial case.
 */
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  lintOutputSchema,
  MAX_JSON_DEPTH,
  MAX_OUTPUT_SCHEMA_LENGTH,
  OutputSchema,
} from "./output-schema";
import { FIXTURE_SCHEMA, IMPOSSIBLE_SCHEMA } from "./output-schema.testing";

/** Every shape the subset allows, in one document. */
const ACCEPTED = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  title: "Assessment",
  description: "What the agent decided.",
  additionalProperties: false,
  required: ["verdict", "confidence", "notes", "author"],
  properties: {
    verdict: { type: "string", enum: ["accept", "dismiss"] },
    // Nullable, written the one way the subset allows.
    confidence: { type: ["number", "null"], description: "How sure." },
    notes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: { text: { type: "string" } },
      },
    },
    author: {
      type: "object",
      title: "Author",
      additionalProperties: false,
      required: ["name"],
      properties: { name: { type: "string" } },
    },
  },
};

/**
 * One broken schema per row, each broken in exactly one way, with the pieces
 * its issue has to name: where it is, and what it broke.
 */
const REJECTED: ReadonlyArray<{
  readonly what: string;
  readonly schema: unknown;
  readonly names: ReadonlyArray<string>;
}> = [
  {
    what: "a root that is not an object",
    schema: { type: "string" },
    names: ["object"],
  },
  {
    what: "an object that does not close itself",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["x"],
      properties: { x: { type: "object", required: [], properties: {} } },
    },
    names: ["/properties/x", "additionalProperties"],
  },
  {
    what: "an object whose required omits a property",
    schema: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: { verdict: { type: "string" } },
    },
    names: ["required", "verdict"],
  },
  {
    what: "an array without items",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["x"],
      properties: { x: { type: "array" } },
    },
    names: ["/properties/x", "items"],
  },
  {
    what: "an empty enum",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["x"],
      properties: { x: { type: "string", enum: [] } },
    },
    names: ["/properties/x", "enum"],
  },
  {
    what: "$ref",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["x"],
      properties: { x: { type: "string", $ref: "#/definitions/x" } },
    },
    names: ["/properties/x", "$ref"],
  },
  {
    what: "oneOf",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["x"],
      properties: { x: { type: "string", oneOf: [{ type: "string" }] } },
    },
    names: ["/properties/x", "oneOf"],
  },
  {
    what: "anyOf",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["x"],
      properties: { x: { type: "string", anyOf: [{ type: "string" }] } },
    },
    names: ["/properties/x", "anyOf"],
  },
  {
    what: "patternProperties",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["x"],
      properties: {
        x: {
          type: "object",
          additionalProperties: false,
          required: [],
          properties: {},
          patternProperties: { "^a": { type: "string" } },
        },
      },
    },
    names: ["/properties/x", "patternProperties"],
  },
  {
    what: "minimum",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["x"],
      properties: { x: { type: "number", minimum: 0 } },
    },
    names: ["/properties/x", "minimum"],
  },
  {
    what: "format",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["x"],
      properties: { x: { type: "string", format: "email" } },
    },
    names: ["/properties/x", "format"],
  },
  {
    what: "a required entry naming no property of its own object",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["verdict", "ghost"],
      properties: { verdict: { type: "string" } },
    },
    names: ["required", "ghost"],
  },
  {
    what: "a required entry that is not a property name at all",
    schema: {
      type: "object",
      additionalProperties: false,
      required: [7],
      properties: {},
    },
    names: ["required", "7"],
  },
  {
    what: "an enum value of another type than the node declares",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["x"],
      properties: { x: { type: "number", enum: ["some"] } },
    },
    names: ["/properties/x", "some"],
  },
  {
    what: "a const of another type than the node declares, beside an enum that fits",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["x"],
      properties: { x: { type: "string", enum: ["a"], const: 7 } },
    },
    names: ["/properties/x", "7"],
  },
  {
    what: "an object keyword on a node that is not one",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["x"],
      properties: { x: { type: "string", properties: {} } },
    },
    names: ["/properties/x", "properties"],
  },
  {
    what: "a root that may also be null",
    schema: {
      type: ["object", "null"],
      additionalProperties: false,
      required: [],
      properties: {},
    },
    names: ["object"],
  },
  {
    what: "a keyword outside the subset at the root",
    schema: {
      $ref: "#/definitions/root",
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {},
    },
    names: ["$ref"],
  },
  {
    what: "a $schema that is not draft-07",
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {},
    },
    names: ["$schema"],
  },
];

describe("lintOutputSchema", () => {
  it("accepts nested objects, an array of objects, a string enum, a nullable number, titles and descriptions", () => {
    expect(lintOutputSchema(ACCEPTED)).toEqual([]);
  });

  // The two schemas every live proof runs on. A fixture the lint refuses
  // would be a proof run against a document Hercule would never have sent.
  it("accepts both shared fixtures, the impossible one included", () => {
    expect(lintOutputSchema(FIXTURE_SCHEMA)).toEqual([]);
    expect(lintOutputSchema(IMPOSSIBLE_SCHEMA)).toEqual([]);
  });

  it.each(REJECTED)("refuses $what, saying where and what", ({ schema, names }) => {
    const issues = lintOutputSchema(schema);
    expect(issues).toHaveLength(1);
    for (const name of names) expect(issues[0]).toContain(name);
  });
});

/**
 * The bound is on the schema itself rather than on one caller's field, so both
 * ends refuse an oversized document: the controller before a row is written
 * and the runner before a harness is started.
 */
describe("the size bound on a schema", () => {
  const decode = Schema.decodeUnknownResult(OutputSchema);

  /** A schema whose JSON is `length` characters, give or take the padding. */
  const buildSchemaOfLength = (length: number): Record<string, unknown> => ({
    type: "object",
    additionalProperties: false,
    required: ["verdict"],
    properties: { verdict: { type: "string", description: "x".repeat(length) } },
  });

  it("takes a schema at the bound", () => {
    const schema = buildSchemaOfLength(
      MAX_OUTPUT_SCHEMA_LENGTH - JSON.stringify(buildSchemaOfLength(0)).length,
    );
    expect(JSON.stringify(schema).length).toBe(MAX_OUTPUT_SCHEMA_LENGTH);
    expect(decode(schema)._tag).toBe("Success");
  });

  it("refuses one past it, saying what the bound is", () => {
    const refused = decode(buildSchemaOfLength(MAX_OUTPUT_SCHEMA_LENGTH));
    expect(refused._tag).toBe("Failure");
    expect(JSON.stringify(refused)).toContain(String(MAX_OUTPUT_SCHEMA_LENGTH));
  });
});

/**
 * The length is measured with `JSON.stringify`, which recurses once for each
 * level. So a schema is refused for its depth before its length is measured,
 * or a deep enough schema throws instead of being refused.
 */
describe("the depth bound on a schema", () => {
  const decode = Schema.decodeUnknownResult(OutputSchema);

  /** A value nested in arrays this many levels deep. */
  const nestInArrays = (levels: number): unknown =>
    Array.from({ length: levels }).reduce<unknown>((inner) => [inner], "bottom");

  it("takes a schema at the bound, and refuses one level past it", () => {
    // The schema object itself is the first level.
    expect(decode({ items: nestInArrays(MAX_JSON_DEPTH - 1) })._tag).toBe("Success");
    const refused = decode({ items: nestInArrays(MAX_JSON_DEPTH) });
    expect(refused._tag).toBe("Failure");
    expect(JSON.stringify(refused)).toContain(`${String(MAX_JSON_DEPTH)} levels`);
  });

  it("refuses a schema a hundred thousand levels deep, and does not throw", () => {
    const refused = decode({ items: nestInArrays(100_000) });
    expect(refused._tag).toBe("Failure");
    expect(JSON.stringify(refused)).toContain(`${String(MAX_JSON_DEPTH)} levels`);
  });
});
