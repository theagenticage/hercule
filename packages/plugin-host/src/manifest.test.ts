import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { HOST_API, PluginManifest } from "./manifest";

const manifest = {
  id: "fixture",
  displayName: "Fixture Plugin",
  hostApi: HOST_API,
  capabilities: ["providers"],
  configSchema: Schema.Struct({}),
};

const decode = (input: unknown) =>
  Effect.runSyncExit(Schema.decodeUnknownEffect(PluginManifest)(input))._tag;

describe("the plugin manifest", () => {
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
