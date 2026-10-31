/**
 * Tests what the minimax plugin declares about itself, as the catalog reads
 * it: the provider definition it registers, which account kinds it offers and
 * how each is set up.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { ProviderDefinition } from "@hercule/plugin-host";
import { minimax } from "./index";
import { parsePlanUsageBody } from "./usage";

/** Returns the definition the plugin gives the catalog, captured from its registration. */
const captureProviderDefinition = (): ProviderDefinition => {
  const definitions: Array<ProviderDefinition> = [];
  Effect.runSync(
    Effect.orDie(
      minimax.register({
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

const API_KEY_STEP = [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }];
const KEY_CHECK = {
  url: "https://api.minimax.io/v1/models",
  headers: { authorization: "Bearer {apiKey}" },
};

describe("the MiniMax provider", () => {
  it("offers a pay-as-you-go key, entered as one field named apiKey, which runs in pi and has no usage", () => {
    const definition = captureProviderDefinition();

    expect(definition.id).toBe("minimax");
    expect(definition.displayName).toBe("MiniMax");
    expect(definition.kinds.map((kind) => kind.id)).toEqual(["pay-as-you-go-key", "plan-key"]);
    const kind = definition.kinds[0];
    expect(kind.title).toBe("Pay-as-you-go key");
    expect(kind.setup).toEqual(API_KEY_STEP);
    expect(kind.keyCheck).toEqual(KEY_CHECK);
    // MiniMax's balance endpoint is not documented, so there is no gauge.
    expect(kind.usage).toBeUndefined();
    expect(kind.harnesses).toEqual(["pi/pi"]);
    expect(definition.defaultHarnessId).toBe("pi/pi");
  });

  it("offers a plan key, with the same field and key check, whose usage is read from the plan's endpoint", () => {
    const kind = captureProviderDefinition().kinds[1]!;

    expect(kind.title).toBe("Plan key");
    expect(kind.setup).toEqual(API_KEY_STEP);
    expect(kind.keyCheck).toEqual(KEY_CHECK);
    expect(kind.usage).toEqual({
      readBy: "endpoint",
      url: "https://www.minimax.io/v1/token_plan/remains",
      headers: { authorization: "Bearer {apiKey}" },
    });
    expect(kind.harnesses).toEqual(["pi/pi"]);
  });

  it("tells the user the two keys are not interchangeable", () => {
    for (const kind of captureProviderDefinition().kinds) {
      expect(kind.description).toContain("not");
      expect(kind.description).toContain("platform.minimax.io");
    }
  });

  it("registers the usage parser for the plan key kind only", () => {
    const registered: Array<unknown> = [];
    Effect.runSync(
      Effect.orDie(
        minimax.register({
          providers: {
            register: (_definition, options) =>
              Effect.sync(() => {
                registered.push(options?.parseUsageBody);
              }),
          },
        }),
      ),
    );

    expect(registered).toEqual([{ "plan-key": parsePlanUsageBody }]);
  });

  it("reads its Model Catalog from pi and brings the current models into a profile", () => {
    const definition = captureProviderDefinition();
    expect(definition.catalogSource).toEqual({ kind: "harness-probe", harnessId: "pi/pi" });
    expect(definition.defaultSelection).toBe("current-models");
  });

  it("suggests MiniMax-M2.7 for text generation", () => {
    expect(captureProviderDefinition().suggestedTextGenerationModel).toBe("MiniMax-M2.7");
  });
});
