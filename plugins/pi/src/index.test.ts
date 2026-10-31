/**
 * Tests what the pi plugin declares about itself, as the catalog reads it:
 * the definition it registers, and the provider it runs.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { HarnessDefinition } from "@hercule/plugin-host";
import { pi } from "./index";

/** Returns the definition the plugin gives the catalog, captured from its registration. */
const captureHarnessDefinition = (): HarnessDefinition => {
  const definitions: Array<HarnessDefinition> = [];
  Effect.runSync(
    Effect.orDie(
      pi.register({
        harnesses: {
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

describe("the pi harness", () => {
  it("runs Z.ai API keys from ZAI_API_KEY, under the model argument zai/{model}, with its own model list", () => {
    expect(captureHarnessDefinition().runs).toEqual([
      {
        providerId: "zai/zai",
        kinds: [{ kind: "api-key", credentialVariable: "ZAI_API_KEY" }],
        modelArgument: "zai/{model}",
        models: "own-list",
      },
    ]);
  });
});
