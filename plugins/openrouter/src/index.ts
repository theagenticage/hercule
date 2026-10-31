import { Effect, Schema } from "effect";
import {
  HOST_API,
  registerProvider,
  type Plugin,
  type ProviderDefinition,
} from "@hercule/plugin-host";
import { parseKeyBody } from "./key";
import { parseModelsBody } from "./models";

/**
 * The OpenRouter mark, path data only, on the 16x16 grid a plugin's mark uses.
 * It is `icons/openrouter.svg` of `@lobehub/icons-static-svg` 1.101.0, the
 * packaged Lobe Icons (https://github.com/lobehub/lobe-icons, MIT licence),
 * drawn on a 24-unit grid there and scaled by 2/3. The MIT notice is in
 * `packages/ui/src/logos/LICENSE-lobehub.txt`. The hole in the "O" is made by
 * two subpaths in opposite directions, so either fill rule draws it.
 */
const OPENROUTER_MARK_PATH =
  "M12.436 2.58a3.391333 3.391333 0 1 1 0 6.782667L15.8 12.726667c0.426667 0.427333 0.124667 1.158 -0.48 1.158H5.653333a5.652667 5.652667 0 0 1 0 -11.305333h6.783333zM5.652667 4.84a3.391333 3.391333 0 1 0 0 6.784 3.391333 3.391333 0 0 0 0 -6.783333z";

/**
 * OpenRouter as a provider. It authenticates with an API key alone, and pi is
 * the harness that runs its models. The key is also how the controller reads
 * the models the key may use, so the catalog comes from OpenRouter's API and
 * not from a harness.
 *
 * What was checked live (2026-10-31): the key endpoint answers 401 for a bogus
 * key, and the model list answers 200 for any key, so only the key endpoint
 * tells a good key from a bad one. What still needs a real key: a 200 from the
 * key endpoint, which the usage and expiry parsing is written from the
 * documentation for. See spec 16 for the open items.
 */
const definition: ProviderDefinition = {
  id: "openrouter",
  displayName: "OpenRouter",
  kinds: [
    {
      id: "api-key",
      title: "API key",
      description:
        "From the Keys page of your OpenRouter account (openrouter.ai/keys). It is stored on the controller and sent to whichever machine runs a thread, so it is entered once and works on every machine.",
      setup: [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }],
      // The key endpoint, not the model list: with a bogus key the model list
      // still answers 200 with every model, while this endpoint answers 401
      // (checked on 2026-10-31).
      keyCheck: {
        url: "https://openrouter.ai/api/v1/key",
        headers: { authorization: "Bearer {apiKey}" },
      },
      // The same endpoint tells the key's spending limit and what is left of
      // it, and when the key expires.
      usage: {
        readBy: "endpoint",
        url: "https://openrouter.ai/api/v1/key",
        headers: { authorization: "Bearer {apiKey}" },
      },
      harnesses: ["pi/pi"],
    },
  ],
  defaultHarnessId: "pi/pi",
  // The models the key may use, which can differ from the full list when the
  // key's settings or the account's privacy settings exclude some.
  catalogSource: {
    kind: "provider-api",
    url: "https://openrouter.ai/api/v1/models/user",
    headers: { authorization: "Bearer {apiKey}" },
  },
  // OpenRouter lists hundreds of models, so the user picks each one.
  defaultSelection: "none",
};

export const openrouter: Plugin = {
  manifest: {
    id: "openrouter",
    displayName: "OpenRouter",
    hostApi: HOST_API,
    capabilities: ["providers"],
    configSchema: Schema.Struct({}),
    mark: { paths: [OPENROUTER_MARK_PATH] },
  },
  register: (host) =>
    registerProvider(host, definition, {
      parseUsageBody: { "api-key": parseKeyBody },
      parseCatalogBody: parseModelsBody,
    }),
  // Nothing runs on the controller for a provider: the definition and the two
  // body parsers passed to `registerProvider` are everything the plugin
  // contributes.
  activate: () => Effect.succeed(Effect.void),
};
