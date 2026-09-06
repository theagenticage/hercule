import { describe, expect, it } from "vitest";
import { Result, Schema } from "effect";
import { configJsonSchema } from "./config-schema";

describe("configJsonSchema", () => {
  // The shape every plugin with nothing to configure ships, and the one effect
  // derives as "an object or an array" rather than as an empty object schema.
  it("takes a struct with no properties", () => {
    const result = configJsonSchema(Schema.Struct({}));

    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    expect(result.success).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
  });

  it("takes an annotated struct with no properties", () => {
    const result = configJsonSchema(Schema.Struct({}).annotate({ title: "Nothing to configure" }));

    expect(Result.isSuccess(result)).toBe(true);
  });

  it("refuses a union of an object and an array", () => {
    const result = configJsonSchema(
      Schema.Union([Schema.Struct({ token: Schema.String }), Schema.Array(Schema.String)]),
    );

    expect(Result.isFailure(result)).toBe(true);
  });

  it.each([
    ["numbers", Schema.Literals([1, 2])],
    ["booleans", Schema.Literals([true, false])],
  ])("refuses an enum of %s", (_label, mode) => {
    const result = configJsonSchema(Schema.Struct({ mode }));

    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) return;
    expect(result.failure.message).toContain("mode");
  });

  it("refuses a schema that is not an object", () => {
    const result = configJsonSchema(Schema.String);

    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) return;
    expect(result.failure.message).toContain("must be an object with named properties");
  });
});
