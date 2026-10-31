/**
 * The records the model browser's specimen (settings-providers.tsx with
 * `?browser`) draws: an OpenRouter account whose Model Catalog holds 466
 * models, shaped like what the OpenRouter plugin's parser makes of its list
 * (about 55 makers, names without the "Maker: " prefix, a few free models, a few
 * whose price is unknown, one with no maker, one with a very long name), and the section that account has in "Main".
 *
 * The catalog is generated, not recorded: the same names, prices and dates on
 * every load, so the screenshots do not change from one run to the next.
 */
import type {
  ModelCatalog,
  ModelCatalogItem,
  ModelProfile,
  ProviderAccount,
} from "@hercule/contract";
import {
  buildProfileEntry,
  buildProfileSection,
  type ProviderAccountIdentity,
} from "@hercule/client-core/testing";

const OPENROUTER_ID = "01a06d02-8000-7000-8000-000000000a0f";

/** What the profile's builders need of the OpenRouter account. */
const OPENROUTER: ProviderAccountIdentity = {
  id: OPENROUTER_ID,
  providerId: "openrouter/openrouter",
  kind: "api-key",
  harnessId: "pi/pi",
  label: null,
};

/** A maker, how many models it has in the catalog, and the families those models come from. */
const MAKERS: ReadonlyArray<readonly [maker: string, count: number, families: readonly string[]]> =
  [
    [
      "OpenAI",
      117,
      ["GPT-6.1 Terra", "GPT-6", "GPT-6 Luna", "GPT-5.5", "o5", "GPT-4.1", "GPT-OSS"],
    ],
    [
      "Google",
      43,
      ["Gemini 3.1 Pro", "Gemini 3.1 Flash", "Gemini 3 Flash Lite", "Gemma 4", "Nano Banana 2"],
    ],
    ["Qwen", 40, ["Qwen3.5 Max", "Qwen3.5 Coder", "Qwen3.5 Plus", "QwQ", "Qwen3 VL"]],
    [
      "Anthropic",
      34,
      [
        "Claude Opus 5.5",
        "Claude Sonnet 5.5",
        "Claude Haiku 5.5",
        "Claude Opus 4.8",
        "Claude Sonnet 4.6",
      ],
    ],
    ["Z.ai", 20, ["GLM 5.1", "GLM 5 Air", "GLM 4.7", "GLM 4.6V"]],
    [
      "Mistral",
      19,
      ["Mistral Large 3", "Mistral Medium 3.5", "Codestral", "Ministral 8B", "Devstral"],
    ],
    ["DeepSeek", 18, ["DeepSeek V4", "DeepSeek R2", "DeepSeek V3.2"]],
    ["", 17, ["Auto Router", "Body Builder", "Sonar Reasoning"]],
    ["Meta", 16, ["Llama 5 Scout", "Llama 5 Maverick", "Llama 4 Behemoth", "Llama 3.3"]],
    ["NVIDIA", 12, ["Nemotron Ultra", "Nemotron Nano", "Llama Nemotron"]],
    ["MoonshotAI", 10, ["Kimi K3", "Kimi K2.6 Thinking", "Kimi Linear"]],
    ["MiniMax", 9, ["MiniMax M3", "MiniMax M2.5"]],
    ["SpaceXAI", 8, ["Grok 5", "Grok 4.2 Fast", "Grok Code"]],
    ["Tencent", 7, ["Hunyuan A13B", "Hunyuan T2"]],
    ["AionLabs", 6, ["Aion 2.0", "Aion RP"]],
    ["Cohere", 6, ["Command A", "Command R+"]],
    ["ByteDance Seed", 6, ["Seed 2.0", "Seed Coder"]],
    ["Xiaomi", 5, ["MiMo V2"]],
    ["Amazon", 5, ["Nova Premier", "Nova Lite"]],
    ["Perplexity", 5, ["Sonar Pro", "Sonar Deep Research"]],
    ["Sakana", 4, ["Fugu"]],
    ["Thinking Machines", 4, ["TM-1"]],
    ["Inception", 3, ["Mercury Coder"]],
    ["LiquidAI", 3, ["LFM2"]],
    ["StepFun", 3, ["Step 3.5"]],
    ["inclusionAI", 3, ["Ling 2", "Ring 2"]],
    ["TheDrummer", 3, ["Cydonia", "Skyfall"]],
    ["Nous", 3, ["Hermes 5"]],
    ...[
      "PrismML",
      "Moondream",
      "ScaleDown",
      "Perceptron",
      "Upstage",
      "Inference.net",
      "Nex AGI",
      "Relace",
      "Morph",
      "Sao10K",
      "Particle AI",
      "Recursive",
      "Elorian",
      "XingChen",
      "Reflection",
      "Fireworks",
      "IBM",
      "Dots Studio",
      "Meituan",
      "xAI",
      "Writer",
      "ByteDance",
      "Venice",
      "Microsoft",
      "Mancer",
      "TypeSafe",
      "OpenRouter",
    ].map((maker): [string, number, string[]] => [
      maker,
      maker.length % 2 === 0 ? 2 : 1,
      [`${maker} One`, `${maker} Two`],
    ]),
  ];

const SUFFIXES = ["", " Pro", " Mini", " (free)", " Preview", " Thinking", " Instruct", " (batch)"];
const CONTEXTS = [
  8_192, 32_768, 65_536, 128_000, 200_000, 262_144, 400_000, 1_000_000, 1_048_576, 2_000_000,
];
/** Input prices in US dollars per million tokens: the output price is a multiple of it. */
const PRICES = [0.05, 0.1, 0.15, 0.3, 0.6, 1, 1.25, 2, 3, 5, 10, 15];

/** Returns a number in `[0, 1)` that depends only on `seed`, so the catalog is the same on every load. */
const spread = (seed: number): number => {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

const slugOf = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-|-$/g, "");

const buildOpenRouterModels = (): ModelCatalogItem[] => {
  const models: ModelCatalogItem[] = [];
  for (const [maker, count, families] of MAKERS) {
    for (let at = 0; at < count; at += 1) {
      const seed = models.length + 1;
      const family = families[at % families.length]!;
      const suffix = SUFFIXES[Math.floor(at / families.length) % SUFFIXES.length]!;
      const base = `${family}${suffix}`;
      const isFree = suffix === " (free)";
      const inputPrice = PRICES[Math.floor(spread(seed) * PRICES.length)]!;
      const priced =
        family === "Auto Router"
          ? {}
          : isFree
            ? { inputPrice: 0, outputPrice: 0 }
            : {
                inputPrice,
                outputPrice:
                  Math.round(inputPrice * (3 + Math.floor(spread(seed + 1) * 3)) * 1000) / 1000,
              };
      models.push({
        slug: `${maker === "" ? "openrouter" : slugOf(maker)}/${slugOf(base)}${at >= families.length * SUFFIXES.length ? `-${String(at)}` : ""}`,
        name: base,
        imageInput: spread(seed + 2) < 0.45 ? { maxBytes: null } : null,
        options: [],
        firstSeenAt: "2026-10-30T09:00:00.000Z",
        ...(maker === "" ? {} : { maker }),
        contextWindow: CONTEXTS[Math.floor(spread(seed + 3) * CONTEXTS.length)]!,
        ...priced,
        releasedAt: new Date(
          Date.UTC(2026, 9, 30) - Math.floor(spread(seed + 4) * 540) * 86_400_000,
        ).toISOString(),
        tools: spread(seed + 5) < 0.8,
        reasoning: spread(seed + 6) < 0.4,
      });
    }
  }
  const google = models.findIndex((model) => model.maker === "Google");
  models[google] = {
    ...models[google]!,
    name: "Nano Banana 2 Lite (Gemini 3.1 Flash Lite Image Preview, extended output and long context)",
  };
  return models;
};

/** The catalog `providerAccount.readCatalog` answers with for the OpenRouter account: 466 models. */
export const OPENROUTER_CATALOG: ModelCatalog = {
  providerAccountId: OPENROUTER_ID,
  readAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  error: null,
  models: buildOpenRouterModels(),
};

/** The OpenRouter account, with the catalog above read three hours before the page loads. */
export const OPENROUTER_ACCOUNT: ProviderAccount = {
  id: OPENROUTER_ID,
  providerId: "openrouter/openrouter",
  kind: "api-key",
  label: null,
  identity: null,
  planLabel: null,
  defaultHarnessId: "pi/pi",
  expiresAt: null,
  usage: [],
  failure: null,
  snapshots: [],
  createdAt: "2026-09-10T09:00:00.000Z",
  updatedAt: "2026-09-10T09:00:00.000Z",
  modelCount: OPENROUTER_CATALOG.models.length,
  catalogReadAt: OPENROUTER_CATALOG.readAt,
  catalogError: null,
  readiness: [],
};

/** Returns `profile` with a section for the OpenRouter account at the end, holding three of its models. */
export const addOpenRouterSection = (profile: ModelProfile): ModelProfile => ({
  ...profile,
  accounts: [
    ...profile.accounts,
    buildProfileSection(
      OPENROUTER,
      OPENROUTER_CATALOG.models
        .slice(0, 3)
        .map((model) => buildProfileEntry(OPENROUTER, model.slug, { name: model.name })),
    ),
  ],
});
