import { describe, expect, it } from "vitest";
import { Result, Schema } from "effect";
import { deriveConfigJsonSchema, secret } from "./config-schema";

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
  // Schema.optional adds a null branch; Schema.optionalKey does not.
  ["Schema.optional", Schema.Struct({ nickname: Schema.optional(Schema.String) }), "nickname"],
  ["an identified inner schema", Schema.Struct({ server: IdentifiedInner }), "server"],
];

describe("deriveConfigJsonSchema", () => {
  it("derives an object schema from a flat supported struct", () => {
    const result = deriveConfigJsonSchema(supported);

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
    // The optional key is the one missing from `required`.
    expect(result.success.required).toEqual(["token", "ratio", "count", "enabled", "mode", "tags"]);
  });

  it.each(unsupported)(
    "rejects %s, with the property in the message",
    (_label, schema, property) => {
      const result = deriveConfigJsonSchema(schema);

      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      expect(result.failure._tag).toBe("UnsupportedConfigSchema");
      expect(result.failure.message).toContain(property);
    },
  );

  // Every plugin with nothing to configure uses this shape, and Effect derives
  // it as "an object or an array" rather than as an empty object schema.
  it("accepts a struct with no properties", () => {
    const result = deriveConfigJsonSchema(Schema.Struct({}));

    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    expect(result.success).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
  });

  it("accepts an annotated struct with no properties", () => {
    const result = deriveConfigJsonSchema(
      Schema.Struct({}).annotate({ title: "Nothing to configure" }),
    );

    expect(Result.isSuccess(result)).toBe(true);
  });

  it("rejects a union of an object and an array", () => {
    const result = deriveConfigJsonSchema(
      Schema.Union([Schema.Struct({ token: Schema.String }), Schema.Array(Schema.String)]),
    );

    expect(Result.isFailure(result)).toBe(true);
  });

  it.each([
    ["numbers", Schema.Literals([1, 2])],
    ["booleans", Schema.Literals([true, false])],
  ])("rejects an enum of %s", (_label, mode) => {
    const result = deriveConfigJsonSchema(Schema.Struct({ mode }));

    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) return;
    expect(result.failure.message).toContain("mode");
  });

  it("rejects a schema that is not an object", () => {
    const result = deriveConfigJsonSchema(Schema.String);

    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) return;
    expect(result.failure.message).toContain("must be an object with named properties");
  });
});

/**
 * A secret config field. The plugin marks one with `secret`, the derived JSON
 * Schema marks it too, and the form masks the input and never reads a value
 * back. Only a string field can be secret: every other field the form shows is
 * a widget with no masked version.
 */
describe("a config field the plugin marked secret", () => {
  it("derives as a string with the plugin's own title, description and the secret marker", () => {
    const result = deriveConfigJsonSchema(
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

  it("leaves an unmarked field unmarked", () => {
    const result = deriveConfigJsonSchema(Schema.Struct({ token: Schema.String }));

    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    expect(result.success.properties).toEqual({ token: { type: "string" } });
  });

  it.each([
    ["a number", Schema.Finite.annotate({ secret: true })],
    ["a boolean", Schema.Boolean.annotate({ secret: true })],
    ["a list of strings", Schema.Array(Schema.String).annotate({ secret: true })],
  ])("rejects %s marked secret, with the property in the message", (_label, marked) => {
    const result = deriveConfigJsonSchema(Schema.Struct({ zaiApiKey: marked }));

    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) return;
    expect(result.failure._tag).toBe("UnsupportedConfigSchema");
    expect(result.failure.message).toContain("zaiApiKey");
  });
});
