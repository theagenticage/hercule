/**
 * What the pi plugin declares about itself, read the way the catalog reads it:
 * the definition it registers, and the form the derivation makes of its config.
 *
 * The key is a paid credential, so the field it is entered in is the plugin's
 * own words and the plugin's own marking - never the runner's, never the UI's.
 */
import { describe, expect, it } from "vitest";
import { Effect, Result } from "effect";
import { configJsonSchema, type ProviderDefinition } from "@hydra/plugin-host";
import { pi } from "./index";

/** The definition the plugin hands the catalog, captured from its registration. */
const registered = (): ProviderDefinition => {
  const definitions: Array<ProviderDefinition> = [];
  Effect.runSync(
    Effect.orDie(
      pi.register({
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

describe("the pi provider's config", () => {
  it("declares the Z.ai key as its one secret-valued field", () => {
    const result = configJsonSchema(registered().configSchema);

    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;

    const properties = result.success.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(properties)).toEqual(["zaiApiKey"]);
    const field = properties["zaiApiKey"]!;
    expect(field["type"]).toBe("string");
    expect(field["x-secret"]).toBe(true);
    // The title is the vendor's, not the harness's: the key is Z.ai's.
    expect(field["title"]).toBe("Z.ai API key");
    expect(String(field["description"])).toContain("Coding Plan");
    expect(String(field["title"])).not.toContain("pi");
  });
});
