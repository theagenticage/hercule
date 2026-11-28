import { Effect, Schema } from "effect";
import {
  HOST_API,
  registerProvider,
  type Plugin,
  type ProviderDefinition,
} from "@hercule/plugin-host";

/**
 * The OpenAI mark, path data only, on the 16x16 grid a plugin's mark uses. It
 * is the desktop app's OpenAI mark (Simple Icons, CC0), drawn on a 24-unit
 * grid there, with every coordinate and arc radius scaled by 2/3 and rounded
 * to six decimals, so it draws the same pixels as the original. Arc flags and
 * rotation are unchanged.
 */
const OPENAI_MARK_PATH =
  "M14.8546 6.5474a3.9898 3.9898 0 0 0 -0.3438 -3.273867 4.0308 4.0308 0 0 0 -4.339867 -1.933333A4.0434 4.0434 0 0 0 3.320467 2.787867a3.9898 3.9898 0 0 0 -2.665133 1.933333 4.0308 4.0308 0 0 0 0.495133 4.731067 3.986667 3.986667 0 0 0 0.340667 3.2738 4.034 4.034 0 0 0 4.343067 1.9334A3.9898 3.9898 0 0 0 8.839933 16a4.037133 4.037133 0 0 0 3.847867 -2.803867 3.992933 3.992933 0 0 0 2.665133 -1.9334 4.037133 4.037133 0 0 0 -0.498333 -4.715267zm-6.014667 8.4054a2.983667 2.983667 0 0 1 -1.9176 -0.693867l0.0946 -0.0536 3.185533 -1.8388a0.529867 0.529867 0 0 0 0.2618 -0.4542v-4.491267l1.346667 0.779067a0.047333 0.047333 0 0 1 0.025333 0.034667v3.721733a3.002667 3.002667 0 0 1 -2.996333 2.996267zm-6.440467 -2.750267a2.980533 2.980533 0 0 1 -0.3564 -2.009133l0.094667 0.0568 3.188667 1.8388a0.514133 0.514133 0 0 0 0.5204 0l3.8952 -2.245667v1.554933a0.0536 0.0536 0 0 1 -0.022133 0.041L6.493333 13.300133a2.999467 2.999467 0 0 1 -4.093867 -1.0976zM1.560533 5.263733a2.99 2.99 0 0 1 1.577 -1.3152V7.733333a0.510933 0.510933 0 0 0 0.2586 0.451l3.876267 2.2362 -1.346733 0.779a0.050467 0.050467 0 0 1 -0.047333 0l-3.2202 -1.857667A3.002667 3.002667 0 0 1 1.560533 5.248zm11.0642 2.570533L8.735867 5.576 10.079467 4.8a0.050467 0.050467 0 0 1 0.047333 0l3.2202 1.860867a2.996267 2.996267 0 0 1 -0.451 5.4028v-3.7848a0.526667 0.526667 0 0 0 -0.271333 -0.444667zm1.340467 -2.0154l-0.094667 -0.0568 -3.182333 -1.854533a0.517267 0.517267 0 0 0 -0.5236 0L6.272667 6.153133V4.598267a0.044133 0.044133 0 0 1 0.018933 -0.041l3.2202 -1.857733a2.999467 2.999467 0 0 1 4.453467 3.106667zM5.537667 8.575333l-1.346667 -0.775867a0.0536 0.0536 0 0 1 -0.025333 -0.0378V4.049467a2.999467 2.999467 0 0 1 4.917133 -2.302467l-0.094667 0.053667L5.802667 3.639333a0.529867 0.529867 0 0 0 -0.2618 0.4542zm0.731733 -1.576933l1.734667 -0.999867 1.737933 0.999867v1.9996l-1.7316 0.9998 -1.7378 -0.9998Z";

/**
 * OpenAI as a provider. A ChatGPT subscription is signed in through Codex's
 * own login on each machine, so Codex is the one harness that kind lists. An
 * API key runs in Codex and in pi.
 */
const definition: ProviderDefinition = {
  id: "openai",
  displayName: "OpenAI",
  kinds: [
    {
      id: "subscription-per-machine",
      title: "ChatGPT subscription, signed in on each machine",
      description:
        "Uses your ChatGPT plan through Codex. You sign in to Codex once on each machine that runs it.",
      setup: [{ kind: "harness-login", method: "sign-in" }],
      // Codex's probe reads the plan's limits, and running sessions report them too.
      usage: { readBy: "harness", harnessId: "codex/codex" },
      harnesses: ["codex/codex"],
    },
    {
      id: "api-key",
      title: "API key",
      description:
        "From the OpenAI platform. It is stored on the controller and sent to whichever machine runs a thread, so it is entered once and works on every machine.",
      setup: [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }],
      keyCheck: {
        url: "https://api.openai.com/v1/models",
        headers: { authorization: "Bearer {apiKey}" },
      },
      harnesses: ["codex/codex", "pi/pi"],
    },
  ],
  defaultHarnessId: "codex/codex",
  catalogSource: { kind: "harness-probe", harnessId: "codex/codex" },
  defaultSelection: "current-models",
  // Codex lists this model from release 0.162 on. On an older release it is
  // not in the account's model list, so Automatic passes over this provider
  // rather than ask for a model that is not there.
  suggestedTextGenerationModel: "gpt-6-luna",
};

export const openai: Plugin = {
  manifest: {
    id: "openai",
    displayName: "OpenAI",
    hostApi: HOST_API,
    capabilities: ["providers"],
    configSchema: Schema.Struct({}),
    mark: { paths: [OPENAI_MARK_PATH] },
  },
  register: (host) => registerProvider(host, definition),
  // Nothing runs on the controller for a provider yet: the definition above is
  // everything the plugin contributes.
  activate: () => Effect.succeed(Effect.void),
};
