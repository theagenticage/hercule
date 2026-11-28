/**
 * Tests what the openrouter plugin declares about itself, as the catalog reads
 * it: the provider definition it registers, which account kinds it offers, how
 * each is set up, and where its Model Catalog comes from.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { ProviderDefinition, ProviderRegistrationOptions } from "@hercule/plugin-host";
import { openrouter } from "./index";
import { parseKeyBody } from "./key";
import { parseModelsBody } from "./models";

/** Returns the definition and the options the plugin registers its provider with. */
const captureRegistration = (): {
  definition: ProviderDefinition;
  options: ProviderRegistrationOptions | undefined;
} => {
  const registrations: Array<{
    definition: ProviderDefinition;
    options: ProviderRegistrationOptions | undefined;
  }> = [];
  Effect.runSync(
    Effect.orDie(
      openrouter.register({
        providers: {
          register: (definition, options) =>
            Effect.sync(() => {
              registrations.push({ definition, options });
            }),
        },
      }),
    ),
  );
  expect(registrations).toHaveLength(1);
  return registrations[0]!;
};

describe("the OpenRouter provider", () => {
  it("offers an API key, entered as one field named apiKey, which runs in pi", () => {
    const { definition } = captureRegistration();

    expect(definition.id).toBe("openrouter");
    expect(definition.displayName).toBe("OpenRouter");
    expect(definition.kinds).toHaveLength(1);
    const kind = definition.kinds[0];
    expect(kind.id).toBe("api-key");
    expect(kind.setup).toEqual([
      { kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] },
    ]);
    // The key endpoint answers 401 for a bogus key. The model list does not,
    // so it must not be the key check.
    expect(kind.keyCheck).toEqual({
      url: "https://openrouter.ai/api/v1/key",
      headers: { authorization: "Bearer {apiKey}" },
    });
    expect(kind.usage).toEqual({
      readBy: "endpoint",
      url: "https://openrouter.ai/api/v1/key",
      headers: { authorization: "Bearer {apiKey}" },
    });
    expect(kind.harnesses).toEqual(["pi/pi"]);
    expect(definition.defaultHarnessId).toBe("pi/pi");
    // The key is a paid credential: the description tells the user where it is kept.
    expect(kind.description).toContain("openrouter.ai/keys");
  });

  it("reads its Model Catalog from OpenRouter's API with the key, and puts no model into a profile by itself", () => {
    const { definition } = captureRegistration();

    expect(definition.catalogSource).toEqual({
      kind: "provider-api",
      url: "https://openrouter.ai/api/v1/models/user",
      headers: { authorization: "Bearer {apiKey}" },
    });
    expect(definition.defaultSelection).toBe("none");
    expect(definition.suggestedTextGenerationModel).toBeUndefined();
  });

  it("registers the key parser for the API key kind and the model list parser for the catalog", () => {
    const { options } = captureRegistration();

    expect(options).toEqual({
      parseUsageBody: { "api-key": parseKeyBody },
      parseCatalogBody: parseModelsBody,
    });
  });
});
