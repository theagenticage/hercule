import { Effect, Schema } from "effect";
import {
  HOST_API,
  registerProvider,
  type Plugin,
  type ProviderDefinition,
} from "@hercule/plugin-host";

/**
 * The Anthropic mark, path data only, on the 16x16 grid a plugin's mark uses.
 * It is the desktop app's Claude mark (Simple Icons, CC0), drawn on a 24-unit
 * grid there, with every coordinate and arc radius scaled by 2/3 and rounded
 * to six decimals, so it draws the same pixels as the original.
 */
const ANTHROPIC_MARK_PATH =
  "M11.536067 2.360667h-2.447867l4.464 11.278667H16Zm-7.072133 0L0 13.639333h2.496133l0.912867 -2.368467h4.670133l0.912867 2.368533h2.496133L7.0242 2.3606Zm-0.247467 6.815467 1.5276 -3.963733 1.5276 3.963733Z";

/**
 * Anthropic as a provider. A Claude subscription is signed in through Claude
 * Code's own login on each machine, and Anthropic's terms let a subscription
 * run in Claude Code only, so that is the one harness the kind lists.
 */
const definition: ProviderDefinition = {
  id: "anthropic",
  displayName: "Anthropic",
  kinds: [
    {
      id: "subscription-per-machine",
      title: "Claude subscription, signed in on each machine",
      description:
        "Uses your Claude Pro or Max plan. You sign in to Claude Code once on each machine that runs it.",
      setup: [{ kind: "harness-login" }],
      harnesses: ["claude-code/claude-code"],
    },
  ],
  // The model list reports this alias, and it follows the newest Haiku.
  suggestedTextGenerationModel: "haiku",
};

export const anthropic: Plugin = {
  manifest: {
    id: "anthropic",
    displayName: "Anthropic",
    hostApi: HOST_API,
    capabilities: ["providers"],
    configSchema: Schema.Struct({}),
    mark: { paths: [ANTHROPIC_MARK_PATH] },
  },
  register: (host) => registerProvider(host, definition),
  // Nothing runs on the controller for a provider yet: the definition above is
  // everything the plugin contributes.
  activate: () => Effect.succeed(Effect.void),
};
