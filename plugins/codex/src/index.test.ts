/**
 * Tests what the Codex plugin declares about itself, as the catalog
 * reads it: the definition it registers, and the provider it runs.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { HarnessDefinition } from "@hercule/plugin-host";
import { codex } from "./index";

/** Returns the definition the plugin gives the catalog, captured from its registration. */
const captureHarnessDefinition = (): HarnessDefinition => {
  const definitions: Array<HarnessDefinition> = [];
  Effect.runSync(
    Effect.orDie(
      codex.register({
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

describe("the Codex harness", () => {
  it("runs a ChatGPT subscription and an API key from OPENAI_API_KEY, with every model under its own id", () => {
    expect(captureHarnessDefinition().runs).toEqual([
      {
        providerId: "openai/openai",
        kinds: [
          { kind: "subscription-per-machine" },
          { kind: "api-key", credentialVariable: "OPENAI_API_KEY" },
        ],
        modelArgument: "{model}",
        models: "all",
      },
    ]);
  });
});
