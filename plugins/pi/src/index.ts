import { Effect, Schema } from "effect";
import {
  HOST_API,
  registerHarness,
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
  // Z.ai is the only provider this build drives pi against. pi names its
  // models `zai/<id>`, runs only the ones in its own list, and reads the key
  // from ZAI_API_KEY.
  runs: [
    {
      providerId: "zai/zai",
      kinds: [{ kind: "api-key", credentialVariable: "ZAI_API_KEY" }],
      modelArgument: "zai/{model}",
      models: "own-list",
    },
  ],
};

export const pi: Plugin = {
  manifest: {
    id: "pi",
    displayName: "pi",
    hostApi: HOST_API,
    capabilities: ["harnesses"],
    configSchema: Schema.Struct({}),
  },
  register: (host) => registerHarness(host, definition),
  // Nothing runs on the controller for a harness: the runner runs sessions,
  // based on the definition above.
  activate: () => Effect.succeed(Effect.void),
};
