import { Effect, Schema } from "effect";
import {
  HOST_API,
  registerProvider,
  type Plugin,
  type ProviderDefinition,
} from "@hercule/plugin-host";

/**
 * A placeholder mark for Z.ai, path data only, on the 16x16 grid a plugin's
 * mark uses: a "Z" drawn on a 24-unit grid and scaled by 2/3 like the others.
 * Z.ai's own logo is not among the marks the desktop app carries, so this is
 * replaced when it is.
 */
const ZAI_MARK_PATH = "M3 2.333333h10v2.2L6.6 11.466667h6.4v2.2h-10v-2.2l6.4 -6.933333H3z";

/**
 * Z.ai as a provider. It authenticates with an API key alone, and pi is the
 * harness that runs its models.
 */
const definition: ProviderDefinition = {
  id: "zai",
  displayName: "Z.ai",
  kinds: [
    {
      id: "api-key",
      title: "API key",
      description:
        "From your Z.ai Coding Plan subscription. It is stored on the controller and sent to whichever machine runs a thread, so it is entered once and works on every machine.",
      setup: [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }],
      harnesses: ["pi/pi"],
    },
  ],
  // The slug as pi's own model list shows it (`pi --list-models` prints
  // `glm-5.3-flash` under the `zai` provider).
  suggestedTextGenerationModel: "glm-5.3-flash",
};

export const zai: Plugin = {
  manifest: {
    id: "zai",
    displayName: "Z.ai",
    hostApi: HOST_API,
    capabilities: ["providers"],
    configSchema: Schema.Struct({}),
    mark: { paths: [ZAI_MARK_PATH] },
  },
  register: (host) => registerProvider(host, definition),
  // Nothing runs on the controller for a provider yet: the definition above is
  // everything the plugin contributes.
  activate: () => Effect.succeed(Effect.void),
};
