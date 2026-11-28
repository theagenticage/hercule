import { Effect, Schema } from "effect";
import {
  HOST_API,
  registerProvider,
  type Plugin,
  type ProviderDefinition,
} from "@hercule/plugin-host";
import { parsePlanUsageBody } from "./usage";

/**
 * The MiniMax mark, path data only, on the 16x16 grid a plugin's mark uses. It
 * is `packages/static-svg/icons/minimax.svg` of Lobe Icons
 * (https://github.com/lobehub/lobe-icons, commit
 * f25f22c0e7295a76077fe417d23deeb56eefdf3e, MIT licence), drawn on a 24-unit
 * grid there and scaled by 2/3. The MIT notice is in
 * `packages/ui/src/logos/LICENSE-lobehub.txt`. The original sets
 * `fill-rule="evenodd"`; this mark does not need it, because its two outlines
 * never overlap.
 */
const MINIMAX_MARK_PATH =
  "M10.852 1.333333c0.770667 0 1.395333 0.618 1.395333 1.38v8.334a0.493333 0.493333 0 0 0 0.496 0.472667 0.493333 0.493333 0 0 0 0.495333 -0.472667V6.066a1.373333 1.373333 0 0 1 1.380667 -1.366A1.373333 1.373333 0 0 1 16 6.066667v4.374a0.432667 0.432667 0 0 1 -0.434667 0.43 0.432667 0.432667 0 0 1 -0.435333 -0.43V6.066667a0.508 0.508 0 0 0 -0.510667 -0.505333 0.508 0.508 0 0 0 -0.510667 0.505333v4.981333a1.358 1.358 0 0 1 -1.365333 1.350667 1.358 1.358 0 0 1 -1.365333 -1.350667v-8.333333a0.523333 0.523333 0 0 0 -0.525333 -0.502 0.523333 0.523333 0 0 0 -0.526 0.501333l-0.000667 10.602667A1.358 1.358 0 0 1 8.960667 14.666667a1.358 1.358 0 0 1 -1.365333 -1.350667V12.026667c0 -0.237333 0.194667 -0.43 0.434667 -0.43 0.24 0 0.434667 0.192667 0.434667 0.43v1.289333c0 0.175333 0.094667 0.337333 0.248 0.425333 0.153333 0.087333 0.342667 0.087333 0.496 0a0.489333 0.489333 0 0 0 0.248 -0.425333V2.713333c0 -0.762 0.624667 -1.38 1.395333 -1.38zm-3.782667 0c0.770667 0 1.395333 0.618 1.395333 1.38v7.682a0.432 0.432 0 0 1 -0.434667 0.43 0.432 0.432 0 0 1 -0.434667 -0.43V2.713333a0.523333 0.523333 0 0 0 -0.526 -0.52 0.523333 0.523333 0 0 0 -0.526 0.52v9.342a1.373333 1.373333 0 0 1 -1.38 1.365333 1.373333 1.373333 0 0 1 -1.380667 -1.365333V6.066667a0.508 0.508 0 0 0 -0.510667 -0.505333 0.508 0.508 0 0 0 -0.510667 0.505333v2.533333a1.373333 1.373333 0 0 1 -1.380667 1.366A1.373333 1.373333 0 0 1 0 8.6v-0.918667c0 -0.238 0.194667 -0.430667 0.434667 -0.430667 0.24 0 0.435333 0.193333 0.435333 0.430667V8.6c0 0.278667 0.228667 0.504667 0.510667 0.504667s0.510667 -0.226 0.510667 -0.504667V6.066a1.373333 1.373333 0 0 1 1.38 -1.365333 1.373333 1.373333 0 0 1 1.380667 1.365333v5.989333c0 0.279333 0.228667 0.505333 0.511333 0.505333 0.282 0 0.510667 -0.226 0.510667 -0.505333V2.713333c0 -0.762 0.624667 -1.38 1.395333 -1.38z";

/**
 * MiniMax as a provider. Its two kinds of API key are not interchangeable, and
 * pi runs both: its built-in `minimax` provider takes the key from
 * `MINIMAX_API_KEY`.
 *
 * What was checked live, and what still needs a real key: spec 16.
 */
const definition: ProviderDefinition = {
  id: "minimax",
  displayName: "MiniMax",
  kinds: [
    {
      id: "pay-as-you-go-key",
      title: "Pay-as-you-go key",
      description:
        "From the API keys page of the MiniMax platform (platform.minimax.io). A pay-as-you-go key and a plan key are not interchangeable, so pick the kind that matches your key. It is stored on the controller and sent to whichever machine runs a thread, so it is entered once and works on every machine.",
      setup: [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }],
      // MiniMax's model list: a refused key answers HTTP 401.
      keyCheck: {
        url: "https://api.minimax.io/v1/models",
        headers: { authorization: "Bearer {apiKey}" },
      },
      // No usage: a pay-as-you-go account has a balance, not a limit, and the
      // balance endpoint (`/account/query_balance`) is undocumented, so the
      // account shows no gauge.
      harnesses: ["pi/pi"],
    },
    {
      id: "plan-key",
      title: "Plan key",
      description:
        "From your MiniMax M Plan subscription, on platform.minimax.io. A pay-as-you-go key and a plan key are not interchangeable, so pick the kind that matches your key. It is stored on the controller and sent to whichever machine runs a thread, so it is entered once and works on every machine.",
      setup: [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }],
      // The same model list as above. A pay-as-you-go key entered as a plan key
      // likely passes this check. The first usage read then gets status 2057,
      // which the parser turns into a refusal that tells the user to add the key
      // as a pay-as-you-go key.
      keyCheck: {
        url: "https://api.minimax.io/v1/models",
        headers: { authorization: "Bearer {apiKey}" },
      },
      // The plan's limits. This endpoint answers errors with HTTP 200 and a
      // status code in the body, so it cannot be the key check; the parser
      // reads the code instead.
      usage: {
        readBy: "endpoint",
        url: "https://www.minimax.io/v1/token_plan/remains",
        headers: { authorization: "Bearer {apiKey}" },
      },
      harnesses: ["pi/pi"],
    },
  ],
  defaultHarnessId: "pi/pi",
  catalogSource: { kind: "harness-probe", harnessId: "pi/pi" },
  defaultSelection: "current-models",
  // M2.7 and M3 cost the same per token and the highspeed variant costs twice
  // as much. M2.7 is the text-only, smaller model, so it is the pick.
  suggestedTextGenerationModel: "MiniMax-M2.7",
};

export const minimax: Plugin = {
  manifest: {
    id: "minimax",
    displayName: "MiniMax",
    hostApi: HOST_API,
    capabilities: ["providers"],
    configSchema: Schema.Struct({}),
    mark: { paths: [MINIMAX_MARK_PATH] },
  },
  register: (host) =>
    registerProvider(host, definition, { parseUsageBody: { "plan-key": parsePlanUsageBody } }),
  // Nothing runs on the controller for a provider yet: the definition above is
  // everything the plugin contributes.
  activate: () => Effect.succeed(Effect.void),
};
