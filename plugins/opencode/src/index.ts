import { Effect, Schema } from "effect";
import {
  HOST_API,
  registerProvider,
  type Plugin,
  type ProviderDefinition,
} from "@hercule/plugin-host";
import { parseGoUsageBody } from "./usage";

/**
 * The OpenCode mark, path data only, on the 16x16 grid a plugin's mark uses.
 * It is `packages/static-svg/icons/opencode.svg` of Lobe Icons
 * (https://github.com/lobehub/lobe-icons, commit
 * 63c800e3db6427b3f156f7b88d426ccb3f7277a1, MIT licence), drawn on a 24-unit
 * grid there and scaled by 2/3. The MIT notice is in
 * `packages/ui/src/logos/LICENSE-lobehub.txt`. The hole is made by two
 * subpaths in opposite directions, so either fill rule draws it.
 */
const OPENCODE_MARK_PATH =
  "M10.666667 4H5.333333v8h5.333333V4zm2.666667 10.666667H2.666667V1.333333h10.666667v13.333333z";

/**
 * OpenCode as a provider. Its two ways to pay, Go (a flat subscription) and
 * Zen (pay as you go), each give an API key, and pi runs their models. Pi lists
 * the Go models under its `opencode-go` provider and the Zen models under
 * `opencode`, so the two kinds have different model catalogs.
 *
 * What was checked live, and what still needs a real key: spec 16.
 */
const definition: ProviderDefinition = {
  id: "opencode",
  displayName: "OpenCode",
  kinds: [
    {
      id: "go-key",
      title: "Go key",
      description:
        "From your OpenCode Go subscription, in the OpenCode console at opencode.ai. It is stored on the controller and sent to whichever machine runs a thread, so it is entered once and works on every machine.",
      setup: [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }],
      // The key is checked against the usage endpoint, not the models list,
      // because a key without a Go subscription is refused here with 403
      // ("OpenCode Go subscription required.") while the models list probably
      // accepts it. The key check reads 401 and 403 as a refused key, so a Zen
      // key entered as a Go key is turned away at entry.
      keyCheck: {
        url: "https://opencode.ai/zen/go/v1/usage",
        headers: { authorization: "Bearer {apiKey}" },
      },
      // The subscription's rolling, weekly and monthly limits.
      usage: {
        readBy: "endpoint",
        url: "https://opencode.ai/zen/go/v1/usage",
        headers: { authorization: "Bearer {apiKey}" },
      },
      harnesses: ["pi/pi"],
    },
    {
      id: "zen-key",
      title: "Zen key",
      description:
        "From your OpenCode Zen balance, in the OpenCode console at opencode.ai. It is stored on the controller and sent to whichever machine runs a thread, so it is entered once and works on every machine.",
      setup: [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }],
      // The Zen models list: the cheapest authenticated read.
      keyCheck: {
        url: "https://opencode.ai/zen/v1/models",
        headers: { authorization: "Bearer {apiKey}" },
      },
      // No `usage`: Zen is pay as you go, so there is no limit to show a gauge for.
      harnesses: ["pi/pi"],
    },
  ],
  defaultHarnessId: "pi/pi",
  catalogSource: { kind: "harness-probe", harnessId: "pi/pi" },
  defaultSelection: "current-models",
  // One slug serves both kinds, because a provider has one suggestion and pi
  // lists `glm-5.3-flash`, the cheapest model, under both `opencode` and
  // `opencode-go`.
  suggestedTextGenerationModel: "glm-5.3-flash",
};

export const opencode: Plugin = {
  manifest: {
    id: "opencode",
    displayName: "OpenCode",
    hostApi: HOST_API,
    capabilities: ["providers"],
    configSchema: Schema.Struct({}),
    mark: { paths: [OPENCODE_MARK_PATH] },
  },
  register: (host) =>
    registerProvider(host, definition, { parseUsageBody: { "go-key": parseGoUsageBody } }),
  // Nothing runs on the controller for a provider yet: the definition above is
  // everything the plugin contributes.
  activate: () => Effect.succeed(Effect.void),
};
