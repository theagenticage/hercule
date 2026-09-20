import { Effect, Schema } from "effect";
import {
  HOST_API,
  registerProvider,
  type Plugin,
  type ProviderDefinition,
} from "@hercule/plugin-host";

/**
 * What `codex app-server` can do, at the version Hercule pins. Every value is a
 * fact, so the controller and the UI read their affordances off this rather
 * than off the provider's name.
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
  // Nothing runs on the controller for a provider: execution lives on the
  // runner, keyed by the definition above.
  activate: () => Effect.succeed(Effect.void),
};
