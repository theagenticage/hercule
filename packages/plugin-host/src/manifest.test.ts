import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { HOST_API, PLUGIN_CAPABILITIES, PluginManifest } from "./manifest";

const configSchema = Schema.Struct({});

const manifest = {
  id: "fixture",
  displayName: "Fixture Plugin",
  hostApi: HOST_API,
  capabilities: ["providers"],
  configSchema,
};

const decode = (input: unknown) =>
  Effect.runSyncExit(Schema.decodeUnknownEffect(PluginManifest)(input))._tag;

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
    const decoded = Effect.runSync(
      Schema.decodeUnknownEffect(PluginManifest)({
        ...manifest,
        capabilities: ["providers", "kv"],
      }),
    );

    expect(decoded.id).toBe("fixture");
    expect(decoded.displayName).toBe("Fixture Plugin");
    expect(decoded.hostApi).toBe(1);
    expect(decoded.capabilities).toEqual(["providers", "kv"]);
    // The schema crosses as the very value the plugin authored, not a copy: the
    // host derives the JSON Schema from this object.
    expect(decoded.configSchema).toBe(configSchema);
  });

  it.each(["id", "displayName", "hostApi", "capabilities"])(
    "refuses a manifest without %s",
    (key) => {
      expect(decode(without(key))).toBe("Failure");
    },
  );

  it("takes every capability the package declares", () => {
    expect(decode({ ...manifest, capabilities: PLUGIN_CAPABILITIES })).toBe("Success");
  });

  it.each([
    // Not a capability at all.
    "storage",
    // Near-miss spellings of ones that are.
    "workflowActions",
    "provider",
    "",
  ])("refuses the capability %j", (capability) => {
    expect(decode({ ...manifest, capabilities: [capability] })).toBe("Failure");
    expect(decode({ ...manifest, capabilities: ["providers", capability] })).toBe("Failure");
  });

  it("refuses a host API version that is not an integer", () => {
    expect(decode({ ...manifest, hostApi: "1" })).toBe("Failure");
  });

  // The config schema is the one thing crossing the boundary that is not plain
  // data: the host derives JSON Schema from it and decodes stored config
  // against it, so a manifest without a live schema is not loadable.
  it("requires a config schema", () => {
    const without: Record<string, unknown> = { ...manifest };
    delete without.configSchema;
    expect(decode(without)).toBe("Failure");
  });

  it("refuses a config schema that is not an Effect Schema", () => {
    expect(decode({ ...manifest, configSchema: "not a schema" })).toBe("Failure");
  });

  // The id is the namespace for the plugin's KV keys, its secrets and its
  // contribution ids, and it goes into the associated data that binds a secret
  // to its owner, so anything but a plain slug makes one of those ambiguous.
  it.each(["claude-code", "pi", "gh2"])("accepts the slug %s", (id) => {
    expect(decode({ ...manifest, id })).toBe("Success");
  });

  it.each(["", "Claude", "a|b", "a b", "-lead", "trail-", "a--b", "a_b", "a/b"])(
    "refuses the id %j",
    (id) => {
      expect(decode({ ...manifest, id })).toBe("Failure");
    },
  );
});
