import { Effect, Schema } from "effect";
import {
  HOST_API,
  registerProvider,
  type Plugin,
  type ProviderDefinition,
} from "@hercule/plugin-host";
import { parseGoUsageBody } from "./usage";

/**
 * The OpenCode mark, path data only, on the 16x16 grid a plugin's mark uses:
 * a tall frame with a rectangular hole. It is Lobe Icons' `opencode.svg`
 * (`packages/static-svg/icons/opencode.svg` in https://github.com/lobehub/lobe-icons,
 * last changed in commit 63c800e3db6427b3f156f7b88d426ccb3f7277a1, MIT licence),
 * drawn on a 24-unit grid there, with every coordinate scaled by 2/3 and
 * rounded to six decimals. The MIT notice that goes with it is in
 * `packages/ui/src/logos/LICENSE-lobehub.txt`. The source fills with
 * `currentColor`, and so does the app, so the mark takes the theme's colour.
 * The hole is made by two subpaths that run in opposite directions, which
 * works with either fill rule.
 */
const OPENCODE_MARK_PATH =
  "M10.666667 4H5.333333v8h5.333333V4zm2.666667 10.666667H2.666667V1.333333h10.666667v13.333333z";

/**
 * OpenCode as a provider. Its two ways to pay, Go (a flat subscription) and
 * Zen (pay as you go), each give an API key from the OpenCode console, and pi
 * is the harness that runs their models. Pi lists the Go models under its
 * `opencode-go` provider and the Zen models under `opencode`, so the two kinds
 * have different model catalogs.
 */
const definition: ProviderDefinition = {
  id: "opencode",
  displayName: "OpenCode",
  kinds: [
    {
      id: "go-key",
      title: "OpenCode Go key",
      description:
        "From your OpenCode Go subscription, in the OpenCode console at opencode.ai. It is stored on the controller and sent to whichever machine runs a thread, so it is entered once and works on every machine.",
      setup: [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }],
      // The key is checked against the usage endpoint, not the models list.
      // The key check treats 401 and 403 as a refused key and shows the
      // provider's own words, so a Zen key entered as a Go key is told at entry:
      // the Go models list probably accepts it, but `/usage` answers 403
      // `EntitlementError` "OpenCode Go subscription required.". Checked live
      // with a bogus key on 2026-10-31: HTTP 401 with
      // `{"type":"error","error":{"type":"AuthError","message":"Unauthorized"}}`.
      // Not verified: that a real Go key answers 2xx here, and the 403 for a Zen key
      // (the 403 comes from the source of OpenCode's route, not from a live call).
      keyCheck: {
        url: "https://opencode.ai/zen/go/v1/usage",
        headers: { authorization: "Bearer {apiKey}" },
      },
      // The subscription's rolling, weekly and monthly limits. The body is the
      // one OpenCode's own route builds (see `parseGoUsageBody`). That a real
      // key's answer matches it is not verified here: the shape comes from the
      // route's source and from a response recorded in a public issue.
      usage: {
        readBy: "endpoint",
        url: "https://opencode.ai/zen/go/v1/usage",
        headers: { authorization: "Bearer {apiKey}" },
      },
      harnesses: ["pi/pi"],
    },
    {
      id: "zen-key",
      title: "OpenCode Zen key",
      description:
        "From your OpenCode Zen balance, in the OpenCode console at opencode.ai. It is stored on the controller and sent to whichever machine runs a thread, so it is entered once and works on every machine.",
      setup: [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }],
      // The Zen models list. A refused key answers 401 with the same body as
      // the Go list (checked live with a bogus key on 2026-10-31). That a
      // valid key answers 2xx here is not yet confirmed with a real key.
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
  // One slug serves both kinds, because pi lists the same id under `opencode`
  // (Zen) and `opencode-go` (Go) and a provider has one suggestion. In pi
  // 0.85.1, `glm-5.3-flash` is in both lists and is the cheapest model in
  // each: Zen $0.15 in and $0.50 out per million tokens, Go $0.075 and $0.25.
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
