/**
 * Tests that the catalog JSON Schema has the root's keywords at the top, and
 * keeps only the definitions that some `$ref` still points to.
 */
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { deriveCatalogJsonSchema } from "./json-schema";

const Inner = Schema.Struct({ note: Schema.String }).annotate({ identifier: "Inner" });

interface Category {
  readonly name: string;
  readonly children: ReadonlyArray<Category>;
}

const Category = Schema.Struct({
  name: Schema.String,
  children: Schema.Array(Schema.suspend((): Schema.Codec<Category> => Category)),
}).annotate({ identifier: "Category" });

describe("deriveCatalogJsonSchema", () => {
  it("moves the keywords of a root with an identifier to the top, and drops its definition", () => {
    const derived = deriveCatalogJsonSchema(
      Schema.Struct({ title: Schema.String }).annotate({ identifier: "Thing" }),
    );

    expect(derived).toEqual({
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    });
  });

  it("keeps the definitions the root refers to, and drops the root's own definition", () => {
    const derived = deriveCatalogJsonSchema(
      Schema.Struct({ first: Inner, second: Inner }).annotate({ identifier: "Outer" }),
    );

    expect(derived["type"]).toBe("object");
    expect(derived["properties"]).toEqual({
      first: { $ref: "#/$defs/Inner" },
      second: { $ref: "#/$defs/Inner" },
    });
    expect(Object.keys(derived["$defs"] as object)).toEqual(["Inner"]);
  });

  it("keeps the root's definition for a recursive schema, because a $ref still points to it", () => {
    const derived = deriveCatalogJsonSchema(Category);

    expect(derived["type"]).toBe("object");
    expect(Object.keys(derived["$defs"] as object)).toEqual(["Category"]);
    expect(JSON.stringify(derived["properties"])).toContain('"#/$defs/Category"');
  });

  it("drops the root's definition when a string value only looks like a $ref to it", () => {
    const derived = deriveCatalogJsonSchema(
      Schema.Struct({ pointer: Schema.Literal("#/$defs/Thing") }).annotate({ identifier: "Thing" }),
    );

    expect(derived["type"]).toBe("object");
    expect(derived["$defs"]).toBeUndefined();
  });

  it("returns the root unchanged when the root has no identifier", () => {
    expect(deriveCatalogJsonSchema(Schema.Struct({ count: Schema.Int }))).toEqual(
      Schema.toJsonSchemaDocument(Schema.Struct({ count: Schema.Int })).schema,
    );
  });
});
