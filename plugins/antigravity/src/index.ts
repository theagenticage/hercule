import { Effect, Schema } from "effect";
import {
  HOST_API,
  registerHarness,
  type Plugin,
  type HarnessDefinition,
} from "@hercule/plugin-host";

/**
 * What `agy acp` can do, at the version Hercule pins. Every value is a fact,
 * so the controller and the UI decide what to offer from these values rather
 * than from the harness's name.
 */
const definition: HarnessDefinition = {
  id: "antigravity",
  displayName: "Antigravity",
  binaryName: "agy",
  // `agy` is published as GitHub releases, not on npm.
  releaseSource: { kind: "github-releases", repository: "google-antigravity/antigravity-cli" },
  declared: {
    // A prompt sent during a turn makes the first prompt return while its work
    // goes on, so nothing says when the turn is over. The controller interrupts
    // the turn instead and sends the message as the next one.
    steering: "unsupported",
    // `agy` speaks ACP, which has no fork.
    fork: "unsupported",
    modelSwitch: "in-session",
    accessModes: {
      "approval-required": "native",
      "auto-accept-edits": "native",
      // `agy` lists a mode `auto` in its description, but offered it on no
      // account that was tried (free and paid, agy 1.5.15), so a session
      // cannot be put in it. The controller starts a thread asked for Auto in
      // Auto-accept edits instead.
      auto: "unsupported",
      "full-access": "native",
    },
    // The runner's adapter hands the MCP Gateway to `agy` over HTTP in the
    // session's own request, so the session's servers are reachable.
    mcpPassthrough: "native",
    disallowedTools: "unsupported",
    // ACP takes no output schema for a prompt.
    structuredOutput: "unsupported",
    textGeneration: "unsupported",
  },
  // The login of a Google subscription lives in the Harness Home, so that kind
  // has no credential variable. Antigravity accepts every model the account
  // lists under its own id.
  runs: [
    {
      providerId: "google/google",
      kinds: [{ kind: "subscription-per-machine", modelArgument: "{model}" }],
      models: "all",
    },
  ],
};

export const antigravity: Plugin = {
  manifest: {
    id: "antigravity",
    displayName: "Antigravity",
    hostApi: HOST_API,
    capabilities: ["harnesses"],
    configSchema: Schema.Struct({}),
  },
  register: (host) => registerHarness(host, definition),
  // Nothing runs on the controller for a harness: the runner runs sessions,
  // based on the definition above.
  activate: () => Effect.succeed(Effect.void),
};
