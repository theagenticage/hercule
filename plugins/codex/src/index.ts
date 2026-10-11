import { Effect, Schema } from "effect";
import {
  HOST_API,
  registerProvider,
  type Plugin,
  type ProviderDefinition,
} from "@hercule/plugin-host";

/**
 * What `codex app-server` can do, at the version Hercule pins. Every value is a
 * fact, so the controller and the UI decide what to offer from these values
 * rather than from the provider's name.
 */
const definition: ProviderDefinition = {
  id: "codex",
  displayName: "Codex",
  binaryName: "codex",
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
    // The app-server exposes no per-turn tool denylist.
    disallowedTools: "unsupported",
    structuredOutput: "supported",
  },
  // Codex lists this model from release 0.162 on. On an older release it is
  // not in the instance's model list, so Automatic passes over Codex rather
  // than ask for a model that is not there.
  suggestedTextGenerationModel: "gpt-6-luna",
};

export const codex: Plugin = {
  manifest: {
    id: "codex",
    displayName: "Codex",
    hostApi: HOST_API,
    capabilities: ["providers"],
    configSchema: Schema.Struct({}),
  },
  register: (host) => registerProvider(host, definition),
  // Nothing runs on the controller for a provider: the runner runs sessions,
  // based on the definition above.
  activate: () => Effect.succeed(Effect.void),
};
