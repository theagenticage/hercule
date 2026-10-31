/**
 * Tests what the anthropic plugin declares about itself, as the catalog reads it:
 * the provider definition it registers, which account kinds it offers and
 * how each is set up.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { ProviderDefinition } from "@hercule/plugin-host";
import { anthropic } from "./index";

/** Returns the definition the plugin gives the catalog, captured from its registration. */
const captureProviderDefinition = (): ProviderDefinition => {
  const definitions: Array<ProviderDefinition> = [];
  Effect.runSync(
    Effect.orDie(
      anthropic.register({
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

describe("the Anthropic provider", () => {
  it("offers a Claude subscription signed in on each machine, which runs in Claude Code only", () => {
    const definition = captureProviderDefinition();

    expect(definition.id).toBe("anthropic");
    expect(definition.displayName).toBe("Anthropic");
    const kind = definition.kinds[0];
    expect(kind.id).toBe("subscription-per-machine");
    expect(kind.title).toBe("Claude subscription, signed in on each machine");
    expect(kind.setup).toEqual([{ kind: "harness-login", method: "sign-in" }]);
    expect(kind.harnesses).toEqual(["claude-code/claude-code"]);
  });

  it("offers a Claude subscription token, made by the harness login, which runs in Claude Code only", () => {
    const kind = captureProviderDefinition().kinds[1]!;

    expect(kind.id).toBe("subscription-token");
    expect(kind.title).toBe("Claude subscription, every machine");
    expect(kind.setup).toEqual([{ kind: "harness-login", method: "create-token" }]);
    expect(kind.harnesses).toEqual(["claude-code/claude-code"]);
  });

  it("offers an API key, checked against the models list, which runs in Claude Code and pi", () => {
    const kind = captureProviderDefinition().kinds[2]!;

    expect(kind.id).toBe("api-key");
    expect(kind.title).toBe("API key");
    expect(kind.setup).toEqual([
      { kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] },
    ]);
    expect(kind.keyCheck).toEqual({
      url: "https://api.anthropic.com/v1/models",
      headers: { "x-api-key": "{apiKey}", "anthropic-version": "2023-06-01" },
    });
    expect(kind.harnesses).toEqual(["claude-code/claude-code", "pi/pi"]);
  });

  it("starts new accounts in Claude Code", () => {
    expect(captureProviderDefinition().defaultHarnessId).toBe("claude-code/claude-code");
  });

  it("suggests the haiku alias for text generation", () => {
    expect(captureProviderDefinition().suggestedTextGenerationModel).toBe("haiku");
  });
});
