import { Effect, Schema } from "effect";
import {
  HOST_API,
  registerProvider,
  type Plugin,
  type ProviderDefinition,
} from "@hercule/plugin-host";

/**
 * What the Agent SDK behind Claude Code can do, at the version Hydra pins.
 * Every value is a fact, so the controller and the UI read their affordances
 * off this rather than off the provider's name.
 */
const definition: ProviderDefinition = {
  id: "claude-code",
  displayName: "Claude Code",
  binaryName: "claude",
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

export const claudeCode: Plugin = {
  manifest: {
    id: "claude-code",
    displayName: "Claude Code",
    hostApi: HOST_API,
    capabilities: ["providers"],
    configSchema: Schema.Struct({}),
  },
  register: (host) => registerProvider(host, definition),
  // Nothing runs on the controller for a provider: execution lives on the
  // runner, keyed by the definition above.
  activate: () => Effect.succeed(Effect.void),
};
