/**
 * The JSON Schema the catalog holds for a declared schema: the root's own
 * keywords at the top, and only the definitions that a reference still
 * points at.
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
  it("puts the keywords of a root that has an identifier at the top, and keeps no copy of it", () => {
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

  it("keeps the definitions that the root points at, and drops the copy of the root", () => {
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

  it("keeps the definition of a root that contains itself, because a reference still points at it", () => {
    const derived = deriveCatalogJsonSchema(Category);

    expect(derived["type"]).toBe("object");
    expect(Object.keys(derived["$defs"] as object)).toEqual(["Category"]);
    expect(JSON.stringify(derived["properties"])).toContain('"#/$defs/Category"');
  });

  it("drops the copy of the root where a value in the schema only looks like its pointer", () => {
    const derived = deriveCatalogJsonSchema(
      Schema.Struct({ pointer: Schema.Literal("#/$defs/Thing") }).annotate({ identifier: "Thing" }),
    );

    expect(derived["type"]).toBe("object");
    expect(derived["$defs"]).toBeUndefined();
  });

  it("answers the root as it is where the root has no identifier", () => {
    expect(deriveCatalogJsonSchema(Schema.Struct({ count: Schema.Int }))).toEqual(
      Schema.toJsonSchemaDocument(Schema.Struct({ count: Schema.Int })).schema,
    );
  });
});
