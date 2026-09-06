import { describe, expect, it } from "vitest";
import { Effect, Result, Schema } from "effect";
import { HOST_API, PluginManifest, configJsonSchema } from "./index";

/* -------------------------------------------------------------------------- */
/* The manifest schema and HOST_API                                           */
/* -------------------------------------------------------------------------- */

/** The eleven capability names pinned by spec 05 §5, in the order stated there. */
const CAPABILITIES = [
  "providers",
  "channels",
  "event-sources",
  "workflow-actions",
  "connections",
  "events",
  "notifications",
  "resources",
  "secrets",
  "kv",
  "public-api",
] as const;

const configSchema = Schema.Struct({ token: Schema.String });

const manifest = {
  id: "fixture",
  displayName: "Fixture Plugin",
  hostApi: HOST_API,
  capabilities: ["providers", "kv"],
  configSchema,
};

const decodeManifest = (input: unknown) =>
  Effect.runSyncExit(Schema.decodeUnknownEffect(PluginManifest)(input));

/** A copy of `manifest` without `key`, for asserting a field is required. */
const without = (key: string) => {
  const copy: Record<string, unknown> = { ...manifest };
  delete copy[key];
  return copy;
};

describe("the host API version", () => {
  it("is 1", () => {
    expect(HOST_API).toBe(1);
  });
});

describe("the plugin manifest", () => {
  it("decodes identity, host API, capabilities and the config schema", () => {
    const decoded = Effect.runSync(Schema.decodeUnknownEffect(PluginManifest)(manifest));

    expect(decoded.id).toBe("fixture");
    expect(decoded.displayName).toBe("Fixture Plugin");
    expect(decoded.hostApi).toBe(1);
    expect(decoded.capabilities).toEqual(["providers", "kv"]);
    // The config schema crosses as the Effect Schema the plugin authored, not a
    // copy of it: the host derives the JSON Schema from this very value.
    expect(decoded.configSchema).toBe(configSchema);
  });

  it.each(["id", "displayName", "hostApi", "capabilities"])(
    "refuses a manifest without %s",
    (key) => {
      expect(decodeManifest(without(key))._tag).toBe("Failure");
    },
  );

  it.each(CAPABILITIES)("takes the capability %s", (capability) => {
    expect(decodeManifest({ ...manifest, capabilities: [capability] })._tag).toBe("Success");
  });

  it("takes all eleven at once", () => {
    expect(decodeManifest({ ...manifest, capabilities: CAPABILITIES })._tag).toBe("Success");
  });

  it.each([
    // Not a capability at all.
    "storage",
    // A near-miss spelling of one that is.
    "workflowActions",
    "provider",
    "",
  ])("refuses the capability %s", (capability) => {
    expect(decodeManifest({ ...manifest, capabilities: [capability] })._tag).toBe("Failure");
    expect(decodeManifest({ ...manifest, capabilities: ["providers", capability] })._tag).toBe(
      "Failure",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* configJsonSchema                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Which carrier `configJsonSchema` fails in is not pinned, so this reads either
 * a `Result` or an `Effect` and asserts on what came out of it.
 */
const derive = (schema: Schema.Top) => {
  const produced = configJsonSchema(schema) as unknown;
  return Result.isResult(produced)
    ? (produced as Result.Result<unknown, { readonly _tag: string; readonly message: string }>)
    : Effect.runSync(
        Effect.result(produced as Effect.Effect<unknown, { _tag: string; message: string }>),
      );
};

/**
 * The derived object schema, whether the function hands back the bare schema or
 * the `{ dialect, schema, definitions }` document `toJsonSchemaDocument` emits.
 */
const objectSchema = (value: unknown) => {
  const record = value as Record<string, unknown>;
  const inner = (record.schema ?? record) as Record<string, unknown>;
  return inner;
};

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
  it("derives a draft-2020-12 object schema from a flat supported struct", () => {
    const result = derive(supported);

    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;

    const schema = objectSchema(result.success);
    expect(schema.type).toBe("object");
    expect(schema.properties).toEqual({
      token: { type: "string", title: "API token", description: "Used for every call" },
      nickname: { type: "string", description: "Optional nickname" },
      ratio: { type: "number", title: "Ratio" },
      count: { type: "integer" },
      enabled: { type: "boolean" },
      mode: { type: "string", enum: ["a", "b", "c"], title: "Mode" },
      tags: { type: "array", items: { type: "string" }, description: "Tags" },
    });
    // The optional key is the one absent from `required`.
    expect(schema.required).toEqual(["token", "ratio", "count", "enabled", "mode", "tags"]);
  });

  it.each(unsupported)("refuses %s, naming the property", (_label, schema, property) => {
    const result = derive(schema);

    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) return;

    expect(result.failure._tag).toBe("UnsupportedConfigSchema");
    expect(result.failure.message).toContain(property);
  });
});
