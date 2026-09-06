import { Effect, Schema } from "effect";
import {
  HOST_API,
  registerProvider,
  type Plugin,
  type ProviderDefinition,
} from "@hydra/plugin-host";

/**
 * What pi's RPC mode can do, at the version Hydra pins. Every value is a fact,
 * so the controller and the UI read their affordances off this rather than off
 * the provider's name.
 */
const definition: ProviderDefinition = {
  id: "pi",
  displayName: "pi",
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
  register: (host) => registerProvider(host, definition),
  // Nothing runs on the controller for a provider: execution lives on the
  // runner, keyed by the definition above.
  activate: () => Effect.succeed(Effect.void),
};
