import { Effect, Schema } from "effect";
import {
  HOST_API,
  registerHarness,
  type Plugin,
  type HarnessDefinition,
} from "@hercule/plugin-host";

/**
 * What the Agent SDK behind Claude Code can do, at the version Hercule pins.
 * Every value is a fact, so the controller and the UI decide what to offer from
 * these values rather than from the harness's name.
 */
const definition: HarnessDefinition = {
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
  // The CLI's model list reports this alias, and it follows the newest Haiku.
  suggestedTextGenerationModel: "haiku",
};

export const claudeCode: Plugin = {
  manifest: {
    id: "claude-code",
    displayName: "Claude Code",
    hostApi: HOST_API,
    capabilities: ["providers"],
    configSchema: Schema.Struct({}),
  },
  register: (host) => registerHarness(host, definition),
  // Nothing runs on the controller for a harness: the runner runs sessions,
  // based on the definition above.
  activate: () => Effect.succeed(Effect.void),
};
