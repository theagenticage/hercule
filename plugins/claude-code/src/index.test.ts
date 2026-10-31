/**
 * Tests what the Claude Code plugin declares about itself, as the catalog
 * reads it: the definition it registers, and the provider it runs.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { HarnessDefinition } from "@hercule/plugin-host";
import { claudeCode } from "./index";

/** Returns the definition the plugin gives the catalog, captured from its registration. */
const captureHarnessDefinition = (): HarnessDefinition => {
  const definitions: Array<HarnessDefinition> = [];
  Effect.runSync(
    Effect.orDie(
      claudeCode.register({
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

describe("the Claude Code harness", () => {
  it("runs every Anthropic kind, with every model under its own id, and hands a token or key over in its own variable", () => {
    expect(captureHarnessDefinition().runs).toEqual([
      {
        providerId: "anthropic/anthropic",
        kinds: [
          { kind: "subscription-per-machine" },
          { kind: "subscription-token", credentialVariable: "CLAUDE_CODE_OAUTH_TOKEN" },
          { kind: "api-key", credentialVariable: "ANTHROPIC_API_KEY" },
        ],
        modelArgument: "{model}",
        models: "all",
      },
    ]);
  });
});
