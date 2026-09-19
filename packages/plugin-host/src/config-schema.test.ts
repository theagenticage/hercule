import { describe, expect, it } from "vitest";
import { Result, Schema } from "effect";
import { configJsonSchema, secret } from "./config-schema";

const supported = Schema.Struct({
  token: Schema.String.annotate({ title: "API token", description: "Used for every call" }),
  nickname: Schema.optionalKey(Schema.String.annotate({ description: "Optional nickname" })),
  ratio: Schema.Finite.annotate({ title: "Ratio" }),
  count: Schema.Int,
  enabled: Schema.Boolean,
  mode: Schema.Literals(["a", "b", "c"]).annotate({ title: "Mode" }),
  tags: Schema.Array(Schema.String).annotate({ description: "Tags" }),
});

const Inner = Schema.Struct({ host: Schema.String });
const IdentifiedInner = Schema.Struct({ host: Schema.String }).annotate({ identifier: "Inner" });

const unsupported: ReadonlyArray<readonly [string, Schema.Top, string]> = [
  ["a nested struct", Schema.Struct({ token: Schema.String, server: Inner }), "server"],
  ["an array of structs", Schema.Struct({ servers: Schema.Array(Inner) }), "servers"],
  // Schema.Number emits an anyOf with the Infinity/NaN strings; Schema.Finite
  // is the one authors must use.
  ["Schema.Number", Schema.Struct({ ratio: Schema.Number }), "ratio"],
  // Schema.optional adds a null branch; Schema.optionalKey is the clean one.
  ["Schema.optional", Schema.Struct({ nickname: Schema.optional(Schema.String) }), "nickname"],
  ["an identified inner schema", Schema.Struct({ server: IdentifiedInner }), "server"],
];

describe("configJsonSchema", () => {
  it("derives an object schema from a flat supported struct", () => {
    const result = configJsonSchema(supported);

    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;

    expect(result.success.type).toBe("object");
    expect(result.success.properties).toEqual({
      token: { type: "string", title: "API token", description: "Used for every call" },
      nickname: { type: "string", description: "Optional nickname" },
      ratio: { type: "number", title: "Ratio" },
      count: { type: "integer" },
      enabled: { type: "boolean" },
      mode: { type: "string", enum: ["a", "b", "c"], title: "Mode" },
      tags: { type: "array", items: { type: "string" }, description: "Tags" },
    });
    // The optional key is the one absent from `required`.
    expect(result.success.required).toEqual(["token", "ratio", "count", "enabled", "mode", "tags"]);
  });

  it.each(unsupported)("refuses %s, naming the property", (_label, schema, property) => {
    const result = configJsonSchema(schema);

    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) return;
    expect(result.failure._tag).toBe("UnsupportedConfigSchema");
    expect(result.failure.message).toContain(property);
  });

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

/**
 * A secret-valued config field. The plugin marks one with `secret`, the derived
 * JSON schema says so, and the form that renders it masks the input and never
 * reads a value back. Only a string can be one: everything else the form draws
 * is a widget with no masked equivalent.
 */
describe("a config field the plugin marked secret", () => {
  it("derives as a string carrying the plugin's own words and the secret marker", () => {
    const result = configJsonSchema(
      Schema.Struct({
        zaiApiKey: secret({
          title: "Z.ai API key",
          description: "From your Z.ai Coding Plan subscription.",
        }),
      }),
    );

    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    expect(result.success.properties).toEqual({
      zaiApiKey: {
        type: "string",
        title: "Z.ai API key",
        description: "From your Z.ai Coding Plan subscription.",
        "x-secret": true,
      },
    });
  });

  it("leaves a field nobody marked unmarked", () => {
    const result = configJsonSchema(Schema.Struct({ token: Schema.String }));

    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    expect(result.success.properties).toEqual({ token: { type: "string" } });
  });

  it.each([
    ["a number", Schema.Finite.annotate({ secret: true })],
    ["a boolean", Schema.Boolean.annotate({ secret: true })],
    ["a list of strings", Schema.Array(Schema.String).annotate({ secret: true })],
  ])("refuses %s marked secret, naming the property", (_label, marked) => {
    const result = configJsonSchema(Schema.Struct({ zaiApiKey: marked }));

    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) return;
    expect(result.failure._tag).toBe("UnsupportedConfigSchema");
    expect(result.failure.message).toContain("zaiApiKey");
  });
});
