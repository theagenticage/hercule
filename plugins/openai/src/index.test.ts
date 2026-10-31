/**
 * Tests what the openai plugin declares about itself, as the catalog reads it:
 * the provider definition it registers, which account kinds it offers and
 * how each is set up.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { ProviderDefinition } from "@hercule/plugin-host";
import { openai } from "./index";

/** Returns the definition the plugin gives the catalog, captured from its registration. */
const captureProviderDefinition = (): ProviderDefinition => {
  const definitions: Array<ProviderDefinition> = [];
  Effect.runSync(
    Effect.orDie(
      openai.register({
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

describe("the OpenAI provider", () => {
  it("offers a ChatGPT subscription signed in on each machine, which runs in Codex only", () => {
    const definition = captureProviderDefinition();

    expect(definition.id).toBe("openai");
    expect(definition.displayName).toBe("OpenAI");
    expect(definition.kinds).toHaveLength(1);
    const kind = definition.kinds[0];
    expect(kind.id).toBe("subscription-per-machine");
    expect(kind.title).toBe("ChatGPT subscription, signed in on each machine");
    expect(kind.setup).toEqual([{ kind: "harness-login" }]);
    expect(kind.harnesses).toEqual(["codex/codex"]);
  });

  it("suggests gpt-6-luna for text generation", () => {
    expect(captureProviderDefinition().suggestedTextGenerationModel).toBe("gpt-6-luna");
  });
});
