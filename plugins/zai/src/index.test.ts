/**
 * Tests what the zai plugin declares about itself, as the catalog reads it:
 * the provider definition it registers, which account kinds it offers and
 * how each is set up.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { ProviderDefinition } from "@hercule/plugin-host";
import { zai } from "./index";
import { parseQuotaBody } from "./quota";

/** Returns the definition the plugin gives the catalog, captured from its registration. */
const captureProviderDefinition = (): ProviderDefinition => {
  const definitions: Array<ProviderDefinition> = [];
  Effect.runSync(
    Effect.orDie(
      zai.register({
        providers: {
          register: (definition) =>
            Effect.sync(() => {
              definitions.push(definition);
            }),
        },
      }),
    ),
  );
  expect(definitions).toHaveLength(1);
  return definitions[0]!;
};

describe("the Z.ai provider", () => {
  it("offers an API key, entered as one field named apiKey, which runs in pi", () => {
    const definition = captureProviderDefinition();

    expect(definition.id).toBe("zai");
    expect(definition.displayName).toBe("Z.ai");
    expect(definition.kinds).toHaveLength(1);
    const kind = definition.kinds[0];
    expect(kind.id).toBe("api-key");
    expect(kind.title).toBe("API key");
    expect(kind.setup).toEqual([
      { kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] },
    ]);
    expect(kind.keyCheck).toEqual({
      url: "https://api.z.ai/api/coding/paas/v4/models",
      headers: { authorization: "Bearer {apiKey}" },
    });
    // Z.ai's own usage plugin sends the raw key, with no `Bearer`.
    expect(kind.usage).toEqual({
      readBy: "endpoint",
      url: "https://api.z.ai/api/monitor/usage/quota/limit",
      headers: { authorization: "{apiKey}" },
    });
    expect(kind.harnesses).toEqual(["pi/pi"]);
    expect(definition.defaultHarnessId).toBe("pi/pi");
    // The key is a paid credential: the description tells the user where it is kept.
    expect(kind.description).toContain("Coding Plan");
  });

  it("registers the quota parser for the API key kind", () => {
    const registered: Array<unknown> = [];
    Effect.runSync(
      Effect.orDie(
        zai.register({
          providers: {
            register: (_definition, options) =>
              Effect.sync(() => {
                registered.push(options?.parseUsageBody);
              }),
          },
        }),
      ),
    );

    expect(registered).toEqual([{ "api-key": parseQuotaBody }]);
  });

  it("suggests glm-5.3-flash for text generation", () => {
    expect(captureProviderDefinition().suggestedTextGenerationModel).toBe("glm-5.3-flash");
  });
});
