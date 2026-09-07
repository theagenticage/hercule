import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import type { ProviderDefinition } from "./contributions";
import { PluginError, registerProvider } from "./plugin";

const definition: ProviderDefinition = {
  id: "fixture",
  displayName: "Fixture",
  binaryName: "harness",
  supportsMultipleInstances: true,
  configSchema: Schema.Struct({}),
  defaultConfig: {},
  declared: {
    steering: "native",
    fork: "native",
    modelSwitch: "in-session",
    accessModes: {
      "approval-required": "native",
      "auto-accept-edits": "native",
      auto: "native",
      "full-access": "native",
    },
    mcpPassthrough: "native",
    disallowedTools: "native",
    structuredOutput: "supported",
  },
};

describe("registerProvider", () => {
  it("hands the definition to the surface the host granted", async () => {
    const registered: Array<ProviderDefinition> = [];

    await Effect.runPromise(
      registerProvider(
        {
          providers: {
            register: (one) =>
              Effect.sync(() => {
                registered.push(one);
              }),
          },
        },
        definition,
      ),
    );

    expect(registered).toEqual([definition]);
  });

  it("fails the plugin's own registration, naming the capability, when the surface is absent", async () => {
    // A typed failure rather than a defect or a silent skip: that is what puts
    // the reason in front of the user instead of a plugin that boots fine and
    // contributes nothing.
    const failure = await Effect.runPromise(Effect.flip(registerProvider({}, definition)));

    expect(failure).toBeInstanceOf(PluginError);
    expect(failure.message).toContain("providers");
  });
});
