/**
 * Tests what the opencode plugin declares about itself, as the catalog reads
 * it: the provider definition it registers, which account kinds it offers and
 * how each is set up and read.
 */
import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { PluginManifest, ProviderDefinition } from "@hercule/plugin-host";
import { opencode } from "./index";
import { parseGoUsageBody } from "./usage";

/** Returns the definition and the options the plugin gives the catalog, captured from its registration. */
const captureRegistration = () => {
  const registrations: Array<{
    definition: ProviderDefinition;
    parseUsageBody: unknown;
  }> = [];
  Effect.runSync(
    Effect.orDie(
      opencode.register({
        providers: {
          register: (definition, options) =>
            Effect.sync(() => {
              registrations.push({ definition, parseUsageBody: options?.parseUsageBody });
            }),
        },
      }),
    ),
  );
  expect(registrations).toHaveLength(1);
  return registrations[0]!;
};

/** Returns the account kind of `definition` with the given id, or fails the test when there is none. */
const findKind = (definition: ProviderDefinition, id: string) => {
  const kind = definition.kinds.find((candidate) => candidate.id === id);
  if (kind === undefined) throw new Error(`no account kind ${id}`);
  return kind;
};

describe("the OpenCode provider", () => {
  it("offers a Go key and a Zen key, each entered as one field named apiKey, and each run in pi", () => {
    const { definition } = captureRegistration();

    expect(definition.id).toBe("opencode");
    expect(definition.displayName).toBe("OpenCode");
    expect(definition.kinds.map((kind) => [kind.id, kind.title])).toEqual([
      ["go-key", "Go key"],
      ["zen-key", "Zen key"],
    ]);
    for (const kind of definition.kinds) {
      expect(kind.setup).toEqual([
        { kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] },
      ]);
      expect(kind.harnesses).toEqual(["pi/pi"]);
      // The key is a paid credential: the description tells the user where it is kept.
      expect(kind.description).toContain("stored on the controller");
    }
    expect(definition.defaultHarnessId).toBe("pi/pi");
  });

  it("checks a Go key against the usage endpoint, which refuses a key without Go, and a Zen key against the Zen models list", () => {
    const { definition } = captureRegistration();
    const go = findKind(definition, "go-key");
    const zen = findKind(definition, "zen-key");

    expect(go.keyCheck).toEqual({
      url: "https://opencode.ai/zen/go/v1/usage",
      headers: { authorization: "Bearer {apiKey}" },
    });
    expect(zen.keyCheck).toEqual({
      url: "https://opencode.ai/zen/v1/models",
      headers: { authorization: "Bearer {apiKey}" },
    });
  });

  it("reads the usage of a Go key only, and registers the parser for that kind", () => {
    const { definition, parseUsageBody } = captureRegistration();
    const go = findKind(definition, "go-key");
    const zen = findKind(definition, "zen-key");

    expect(go.usage).toEqual({
      readBy: "endpoint",
      url: "https://opencode.ai/zen/go/v1/usage",
      headers: { authorization: "Bearer {apiKey}" },
    });
    // Zen is pay as you go: no usage declared, so the account shows no gauge.
    expect(zen.usage).toBeUndefined();
    expect(parseUsageBody).toEqual({ "go-key": parseGoUsageBody });
  });

  it("reads its Model Catalog from pi and brings the current models into a profile", () => {
    const { definition } = captureRegistration();

    expect(definition.catalogSource).toEqual({ kind: "harness-probe", harnessId: "pi/pi" });
    expect(definition.defaultSelection).toBe("current-models");
  });

  it("suggests glm-5.3-flash for text generation, a model both of pi's OpenCode lists have", () => {
    expect(captureRegistration().definition.suggestedTextGenerationModel).toBe("glm-5.3-flash");
  });

  it("declares a definition and a manifest the plugin host accepts", () => {
    const { definition } = captureRegistration();

    expect(() => Schema.decodeUnknownSync(ProviderDefinition)(definition)).not.toThrow();
    expect(() => Schema.decodeUnknownSync(PluginManifest)(opencode.manifest)).not.toThrow();
  });
});
