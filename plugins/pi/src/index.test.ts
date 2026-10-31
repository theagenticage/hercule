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
  it("runs the keys of Anthropic, OpenAI, Z.ai, OpenCode and MiniMax, each under its provider's model argument, with its own model list", () => {
    expect(captureHarnessDefinition().runs).toEqual([
      {
        providerId: "anthropic/anthropic",
        kinds: [
          {
            kind: "api-key",
            modelArgument: "anthropic/{model}",
            credentialVariable: "ANTHROPIC_API_KEY",
          },
        ],
        models: "own-list",
      },
      {
        providerId: "openai/openai",
        kinds: [
          {
            kind: "api-key",
            modelArgument: "openai/{model}",
            credentialVariable: "OPENAI_API_KEY",
          },
        ],
        models: "own-list",
      },
      {
        providerId: "zai/zai",
        kinds: [
          { kind: "api-key", modelArgument: "zai/{model}", credentialVariable: "ZAI_API_KEY" },
        ],
        models: "own-list",
      },
      {
        providerId: "opencode/opencode",
        kinds: [
          {
            kind: "go-key",
            modelArgument: "opencode-go/{model}",
            credentialVariable: "OPENCODE_API_KEY",
          },
          {
            kind: "zen-key",
            modelArgument: "opencode/{model}",
            credentialVariable: "OPENCODE_API_KEY",
          },
        ],
        models: "own-list",
      },
      {
        providerId: "minimax/minimax",
        kinds: [
          {
            kind: "pay-as-you-go-key",
            modelArgument: "minimax/{model}",
            credentialVariable: "MINIMAX_API_KEY",
          },
          {
            kind: "plan-key",
            modelArgument: "minimax/{model}",
            credentialVariable: "MINIMAX_API_KEY",
          },
        ],
        models: "own-list",
      },
    ]);
  });
});
