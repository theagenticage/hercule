import { Effect, Schema } from "effect";
import {
  HOST_API,
  registerHarness,
  secret,
  type Plugin,
  type HarnessDefinition,
} from "@hercule/plugin-host";

/**
 * What pi's RPC mode can do, at the version Hercule pins. Every value is a fact,
 * so the controller and the UI decide what to offer from these values rather
 * than from the harness's name.
 */
const definition: HarnessDefinition = {
  id: "pi",
  displayName: "pi",
  binaryName: "pi",
  supportsMultipleInstances: true,
  // Z.ai is the only upstream this build drives pi against, and it authenticates
  // with an API key alone. The key is the user's Z.ai credential, not pi's, so
  // the field is named and worded for Z.ai.
  configSchema: Schema.Struct({
    zaiApiKey: secret({
      title: "Z.ai API key",
      description:
        "From your Z.ai Coding Plan subscription. It is stored on the controller " +
        "and sent to whichever machine runs a thread, so it is entered once and " +
        "works on every machine.",
    }),
  }),
  defaultConfig: {},
  // The slug as pi's own model catalog lists it (`pi --list-models` prints
  // `glm-5.3-flash` under the `zai` provider); the adapter adds the provider.
  suggestedTextGenerationModel: "glm-5.3-flash",
  declared: {
    steering: "native",
    fork: "native",
    modelSwitch: "in-session",
    accessModes: {
      "approval-required": "native",
      "auto-accept-edits": "native",
      // `auto` needs a harness-side reviewer to judge routine actions, and pi
      // has none: its approval mechanics are all-or-nothing.
      auto: "unsupported",
      "full-access": "native",
    },
    // MCP is an extension to pi rather than part of its core, so the pinned
    // version passes nothing through.
    mcpPassthrough: "unsupported",
    disallowedTools: "native",
    structuredOutput: "supported",
  },
};

export const pi: Plugin = {
  manifest: {
    id: "pi",
    displayName: "pi",
    hostApi: HOST_API,
    capabilities: ["providers"],
    configSchema: Schema.Struct({}),
  },
  register: (host) => registerHarness(host, definition),
  // Nothing runs on the controller for a harness: the runner runs sessions,
  // based on the definition above.
  activate: () => Effect.succeed(Effect.void),
};
