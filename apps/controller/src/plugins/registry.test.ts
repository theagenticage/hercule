/**
 * Tests the registry a release ships, as the rest of the system sees it after
 * a boot. The expected values are written out in full rather than derived from
 * each other: the UI builds every control from them, so an accidental change
 * to one must fail here.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { PluginDetail } from "@hercule/contract";
import { checkPluginMark } from "./mark";
import {
  PluginHost,
  Plugins,
  registry,
  type RegisteredHarness,
  type RegisteredProvider,
} from "./index";
import { asUser, buildPluginStack } from "./testing";

/** Runs an effect on a fresh plugin stack, as the user, like a request through the API. */
const run = <A, E>(body: Effect.Effect<A, E, Plugins | PluginHost>) =>
  Effect.runPromise(body.pipe(Effect.provide(buildPluginStack()), asUser));

/** The JSON Schema derived from a config schema with no settings. */
const NO_SETTINGS = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};

/** Written out rather than derived, because copying from the wrong base is the mistake this catches. */
const SHIPPED = [
  {
    id: "claude-code",
    displayName: "Claude Code",
    definition: {
      id: "claude-code/claude-code",
      displayName: "Claude Code",
      binaryName: "claude",
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
      runs: [
        {
          providerId: "anthropic/anthropic",
          kinds: [
            { kind: "subscription-per-machine", modelArgument: "{model}" },
            {
              kind: "subscription-token",
              modelArgument: "{model}",
              credentialVariable: "CLAUDE_CODE_OAUTH_TOKEN",
            },
            { kind: "api-key", modelArgument: "{model}", credentialVariable: "ANTHROPIC_API_KEY" },
          ],
          models: "all",
        },
      ],
    },
  },
  {
    id: "codex",
    displayName: "Codex",
    definition: {
      id: "codex/codex",
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
        disallowedTools: "unsupported",
        structuredOutput: "supported",
      },
      runs: [
        {
          providerId: "openai/openai",
          kinds: [
            { kind: "subscription-per-machine", modelArgument: "{model}" },
            { kind: "api-key", modelArgument: "{model}", credentialVariable: "OPENAI_API_KEY" },
          ],
          models: "all",
        },
      ],
    },
  },
  {
    id: "pi",
    displayName: "pi",
    definition: {
      id: "pi/pi",
      displayName: "pi",
      binaryName: "pi",
      declared: {
        steering: "native",
        fork: "native",
        modelSwitch: "in-session",
        accessModes: {
          "approval-required": "native",
          "auto-accept-edits": "native",
          auto: "unsupported",
          "full-access": "native",
        },
        mcpPassthrough: "unsupported",
        disallowedTools: "native",
        structuredOutput: "supported",
      },
      runs: [
        {
          providerId: "anthropic/anthropic",
          kinds: [
            {
              kind: "api-key",
              modelArgument: "anthropic/{model}",
              credentialVariable: "ANTHROPIC_API_KEY",
            },
          ],
          models: "own-list",
        },
        {
          providerId: "openai/openai",
          kinds: [
            {
              kind: "api-key",
              modelArgument: "openai/{model}",
              credentialVariable: "OPENAI_API_KEY",
            },
          ],
          models: "own-list",
        },
        {
          providerId: "zai/zai",
          kinds: [
            { kind: "api-key", modelArgument: "zai/{model}", credentialVariable: "ZAI_API_KEY" },
          ],
          models: "own-list",
        },
        {
          providerId: "opencode/opencode",
          kinds: [
            {
              kind: "go-key",
              modelArgument: "opencode-go/{model}",
              credentialVariable: "OPENCODE_API_KEY",
            },
            {
              kind: "zen-key",
              modelArgument: "opencode/{model}",
              credentialVariable: "OPENCODE_API_KEY",
            },
          ],
          models: "own-list",
        },
        {
          providerId: "minimax/minimax",
          kinds: [
            {
              kind: "pay-as-you-go-key",
              modelArgument: "minimax/{model}",
              credentialVariable: "MINIMAX_API_KEY",
            },
            {
              kind: "plan-key",
              modelArgument: "minimax/{model}",
              credentialVariable: "MINIMAX_API_KEY",
            },
          ],
          models: "own-list",
        },
      ],
    },
  },
];

/** The providers a release ships, written out in full for the same reason. */
const SHIPPED_PROVIDERS = [
  {
    id: "anthropic",
    displayName: "Anthropic",
    definition: {
      id: "anthropic/anthropic",
      displayName: "Anthropic",
      kinds: [
        {
          id: "subscription-per-machine",
          title: "Claude subscription, signed in on each machine",
          description:
            "Uses your Claude Pro or Max plan. You sign in to Claude Code once on each machine that runs it.",
          setup: [{ kind: "harness-login", method: "sign-in" }],
          usage: { readBy: "harness", harnessId: "claude-code/claude-code" },
          harnesses: ["claude-code/claude-code"],
        },
        {
          id: "subscription-token",
          title: "Claude subscription, every machine",
          description:
            "Uses your Claude Pro or Max plan. Hercule makes a token with Claude Code once, keeps it on the controller, and it works on every machine. It lasts a year.",
          setup: [{ kind: "harness-login", method: "create-token" }],
          usage: { readBy: "sessions" },
          harnesses: ["claude-code/claude-code"],
        },
        {
          id: "api-key",
          title: "API key",
          description:
            "From the Anthropic Console. It is stored on the controller and sent to whichever machine runs a thread, so it is entered once and works on every machine.",
          setup: [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }],
          keyCheck: {
            url: "https://api.anthropic.com/v1/models",
            headers: { "x-api-key": "{apiKey}", "anthropic-version": "2023-06-01" },
          },
          harnesses: ["claude-code/claude-code", "pi/pi"],
        },
      ],
      defaultHarnessId: "claude-code/claude-code",
      catalogSource: { kind: "harness-probe", harnessId: "claude-code/claude-code" },
      defaultSelection: "current-models",
      suggestedTextGenerationModel: "haiku",
    },
  },
  {
    id: "openai",
    displayName: "OpenAI",
    definition: {
      id: "openai/openai",
      displayName: "OpenAI",
      kinds: [
        {
          id: "subscription-per-machine",
          title: "ChatGPT subscription, signed in on each machine",
          description:
            "Uses your ChatGPT plan through Codex. You sign in to Codex once on each machine that runs it.",
          setup: [{ kind: "harness-login", method: "sign-in" }],
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
      suggestedTextGenerationModel: "gpt-6-luna",
    },
  },
  {
    id: "zai",
    displayName: "Z.ai",
    definition: {
      id: "zai/zai",
      displayName: "Z.ai",
      kinds: [
        {
          id: "api-key",
          title: "API key",
          description:
            "From your Z.ai Coding Plan subscription. It is stored on the controller and sent to whichever machine runs a thread, so it is entered once and works on every machine.",
          setup: [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }],
          keyCheck: {
            url: "https://api.z.ai/api/coding/paas/v4/models",
            headers: { authorization: "Bearer {apiKey}" },
          },
          usage: {
            readBy: "endpoint",
            url: "https://api.z.ai/api/monitor/usage/quota/limit",
            headers: { authorization: "{apiKey}" },
          },
          harnesses: ["pi/pi"],
        },
      ],
      defaultHarnessId: "pi/pi",
      catalogSource: { kind: "harness-probe", harnessId: "pi/pi" },
      defaultSelection: "current-models",
      suggestedTextGenerationModel: "glm-5.3-flash",
    },
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    definition: {
      id: "opencode/opencode",
      displayName: "OpenCode",
      kinds: [
        {
          id: "go-key",
          title: "Go key",
          description:
            "From your OpenCode Go subscription, in the OpenCode console at opencode.ai. It is stored on the controller and sent to whichever machine runs a thread, so it is entered once and works on every machine.",
          setup: [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }],
          keyCheck: {
            url: "https://opencode.ai/zen/go/v1/usage",
            headers: { authorization: "Bearer {apiKey}" },
          },
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
          keyCheck: {
            url: "https://opencode.ai/zen/v1/models",
            headers: { authorization: "Bearer {apiKey}" },
          },
          harnesses: ["pi/pi"],
        },
      ],
      defaultHarnessId: "pi/pi",
      catalogSource: { kind: "harness-probe", harnessId: "pi/pi" },
      defaultSelection: "current-models",
      suggestedTextGenerationModel: "glm-5.3-flash",
    },
  },
  {
    id: "minimax",
    displayName: "MiniMax",
    definition: {
      id: "minimax/minimax",
      displayName: "MiniMax",
      kinds: [
        {
          id: "pay-as-you-go-key",
          title: "Pay-as-you-go key",
          description:
            "From the API keys page of the MiniMax platform (platform.minimax.io). A pay-as-you-go key and a plan key are not interchangeable, so pick the kind that matches your key. It is stored on the controller and sent to whichever machine runs a thread, so it is entered once and works on every machine.",
          setup: [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }],
          keyCheck: {
            url: "https://api.minimax.io/v1/models",
            headers: { authorization: "Bearer {apiKey}" },
          },
          harnesses: ["pi/pi"],
        },
        {
          id: "plan-key",
          title: "Plan key",
          description:
            "From your MiniMax M Plan subscription, on platform.minimax.io. A pay-as-you-go key and a plan key are not interchangeable, so pick the kind that matches your key. It is stored on the controller and sent to whichever machine runs a thread, so it is entered once and works on every machine.",
          setup: [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }],
          keyCheck: {
            url: "https://api.minimax.io/v1/models",
            headers: { authorization: "Bearer {apiKey}" },
          },
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
      suggestedTextGenerationModel: "MiniMax-M2.7",
    },
  },
];

let details: ReadonlyArray<PluginDetail>;
let harnesses: ReadonlyArray<RegisteredHarness>;
let providers: ReadonlyArray<RegisteredProvider>;

describe("the shipped registry after a boot", () => {
  beforeAll(async () => {
    details = await run(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        yield* host.boot(registry);
        harnesses = yield* host.harnesses();
        providers = yield* host.providers();
        return yield* Effect.flatMap(Plugins, (plugins) => plugins.query());
      }),
    );
  });

  it("holds the three harness plugins, the five provider plugins and the github, sentry and linear plugins, in registry order", () => {
    expect(details.map((detail) => detail.id)).toEqual([
      "claude-code",
      "codex",
      "pi",
      "anthropic",
      "openai",
      "zai",
      "opencode",
      "minimax",
      "github",
      "sentry",
      "linear",
    ]);
  });

  it.each(SHIPPED)(
    "$id is active, asks nothing of the user, and contributes its harness",
    ({ id, displayName, definition }) => {
      const detail = details.find((one) => one.id === id);

      expect(detail?.displayName).toBe(displayName);
      expect(detail?.status).toEqual({ _tag: "active" });
      expect(detail?.capabilities).toEqual(["harnesses"]);
      expect(detail?.configSchema).toEqual(NO_SETTINGS);

      expect(detail?.contributions).toEqual([
        { extensionPoint: "harness", id: definition.id, definition },
      ]);
    },
  );

  it.each(SHIPPED_PROVIDERS)(
    "$id is active, asks nothing of the user, and contributes its provider",
    ({ id, displayName, definition }) => {
      const detail = details.find((one) => one.id === id);

      expect(detail?.displayName).toBe(displayName);
      expect(detail?.status).toEqual({ _tag: "active" });
      expect(detail?.capabilities).toEqual(["providers"]);
      expect(detail?.configSchema).toEqual(NO_SETTINGS);

      expect(detail?.contributions).toEqual([
        { extensionPoint: "provider", id: definition.id, definition },
      ]);
    },
  );

  it.each(SHIPPED_PROVIDERS)("$id declares a mark that passes the core's check", ({ id }) => {
    const plugin = registry.find((one) => one.manifest.id === id);
    const checked = checkPluginMark(plugin?.manifest.mark);

    expect(checked.markError).toBeUndefined();
    expect(checked.mark?.paths).toHaveLength(1);
    // The host keeps the mark it was given, so the apps draw it.
    expect(details.find((one) => one.id === id)?.mark).toEqual(plugin?.manifest.mark);
  });

  it("agrees with itself: every provider a harness runs lists that harness, and every harness a provider lists runs it", () => {
    for (const harness of harnesses) {
      for (const support of harness.runs) {
        const provider = providers.find((one) => one.id === support.providerId);
        expect(provider, `${harness.id} runs ${support.providerId}`).toBeDefined();
        for (const { kind } of support.kinds) {
          const declared = provider?.kinds.find((one) => one.id === kind);
          expect(declared?.harnesses, `${support.providerId} kind ${kind}`).toContain(harness.id);
        }
      }
    }
    for (const provider of providers) {
      for (const kind of provider.kinds) {
        for (const harnessId of kind.harnesses) {
          const harness = harnesses.find((one) => one.id === harnessId);
          const kinds = harness?.runs.find((one) => one.providerId === provider.id)?.kinds;
          expect(
            kinds?.map((one) => one.kind),
            `${provider.id} kind ${kind.id}`,
          ).toContain(kind.id);
        }
      }
    }
  });
});
