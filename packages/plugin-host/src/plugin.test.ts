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
  it("passes the definition to the service the host granted", async () => {
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

  it("fails the plugin's registration, with the capability in the message, when the service is absent", async () => {
    // A typed failure rather than a defect or a silent skip, so the user sees
    // the reason, instead of a plugin that starts fine and contributes
    // nothing.
    const failure = await Effect.runPromise(Effect.flip(registerProvider({}, definition)));

    expect(failure).toBeInstanceOf(PluginError);
    expect(failure.message).toContain("providers");
  });
});
