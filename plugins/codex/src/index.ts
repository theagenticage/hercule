import { Effect, Schema } from "effect";
import {
  HOST_API,
  registerHarness,
  type Plugin,
  type HarnessDefinition,
} from "@hercule/plugin-host";

/**
 * What `codex app-server` can do, at the version Hercule pins. Every value is a
 * fact, so the controller and the UI decide what to offer from these values
 * rather than from the harness's name.
 */
const definition: HarnessDefinition = {
  id: "codex",
  displayName: "Codex",
  binaryName: "codex",
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
  // The login of a ChatGPT subscription lives in the Harness Home, so the
  // kind has no credential variable, and Codex accepts every model the account
  // lists under its own id.
  runs: [
    {
      providerId: "openai/openai",
      kinds: [{ kind: "subscription-per-machine" }],
      modelArgument: "{model}",
      models: "all",
    },
  ],
};

export const codex: Plugin = {
  manifest: {
    id: "codex",
    displayName: "Codex",
    hostApi: HOST_API,
    capabilities: ["harnesses"],
    configSchema: Schema.Struct({}),
  },
  register: (host) => registerHarness(host, definition),
  // Nothing runs on the controller for a harness: the runner runs sessions,
  // based on the definition above.
  activate: () => Effect.succeed(Effect.void),
};
