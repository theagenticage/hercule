/**
 * Fixtures for tests that run text generation on a real database and the real
 * plugin host: the three providers and three harnesses `automatic` chooses
 * between, named like the shipped ones so their qualified ids are the ones
 * `AUTOMATIC_PROVIDER_ORDER` lists.
 *
 * - `openai/openai` (subscription per machine), run by `codex/codex`;
 * - `zai/zai` (API key), run by `pi/pi`;
 * - `anthropic/anthropic` (subscription per machine), run by
 *   `claude-code/claude-code`.
 */
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { HarnessProviderSupport, Plugin, ProviderDefinition } from "@hercule/plugin-host";
import { TEXT_GENERATION_CAPABILITY, type ProbeResult } from "@hercule/protocol";
import { nowIso, uuidFromString, withTransaction } from "../db";
import { buildHarnessDefinition, createPluginFixture } from "../plugins/testing";
import { providerAccountRepository, type StoredProviderAccount } from "../provider-accounts";
import { runnerRepository } from "../runners";
import { hashToken } from "../credentials";

export const SUBSCRIPTION_KIND = "subscription-per-machine";
export const API_KEY_KIND = "api-key";

/** One provider of the fixtures: its plugin id, the harness that runs it, its kind and suggested model. */
interface FixtureProvider {
  readonly id: string;
  readonly displayName: string;
  readonly harnessId: string;
  readonly kind: string;
  readonly suggestedModel: string;
}

export const FIXTURE_PROVIDERS: Readonly<Record<"openai" | "zai" | "anthropic", FixtureProvider>> =
  {
    openai: {
      id: "openai/openai",
      displayName: "OpenAI",
      harnessId: "codex/codex",
      kind: SUBSCRIPTION_KIND,
      suggestedModel: "codex-mini",
    },
    zai: {
      id: "zai/zai",
      displayName: "Z.ai",
      harnessId: "pi/pi",
      kind: API_KEY_KIND,
      suggestedModel: "pi-small",
    },
    anthropic: {
      id: "anthropic/anthropic",
      displayName: "Anthropic",
      harnessId: "claude-code/claude-code",
      kind: SUBSCRIPTION_KIND,
      suggestedModel: "haiku",
    },
  };

const buildProvider = (provider: FixtureProvider): ProviderDefinition => ({
  id: provider.id.split("/")[1]!,
  displayName: provider.displayName,
  kinds: [
    provider.kind === API_KEY_KIND
      ? {
          id: API_KEY_KIND,
          title: "API key",
          description: "A key.",
          setup: [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }],
          harnesses: [provider.harnessId],
        }
      : {
          id: SUBSCRIPTION_KIND,
          title: "Subscription",
          description: "A plan signed in on each machine.",
          setup: [{ kind: "harness-login" }],
          harnesses: [provider.harnessId],
        },
  ],
  suggestedTextGenerationModel: provider.suggestedModel,
});

const buildRuns = (provider: FixtureProvider): ReadonlyArray<HarnessProviderSupport> => [
  {
    providerId: provider.id,
    kinds: [
      provider.kind === API_KEY_KIND
        ? { kind: API_KEY_KIND, credentialVariable: "ZAI_API_KEY" }
        : { kind: SUBSCRIPTION_KIND },
    ],
    modelArgument: provider.kind === API_KEY_KIND ? "zai/{model}" : "{model}",
    models: provider.kind === API_KEY_KIND ? "own-list" : "all",
  },
];

/** Returns the plugins to boot: each provider's plugin, then each harness's plugin. */
export const buildTextGenerationPlugins = (): ReadonlyArray<Plugin> => [
  ...Object.values(FIXTURE_PROVIDERS).map(
    (provider) =>
      createPluginFixture({
        id: provider.id.split("/")[0]!,
        capabilities: ["providers"],
        definitions: [],
        providers: [buildProvider(provider)],
      }).plugin,
  ),
  ...Object.values(FIXTURE_PROVIDERS).map((provider) => {
    const [pluginId, word] = provider.harnessId.split("/") as [string, string];
    return createPluginFixture({
      id: pluginId,
      definitions: [buildHarnessDefinition(word, buildRuns(provider))],
    }).plugin;
  }),
];

/**
 * Inserts an account of a fixture provider, in the provider's own harness and
 * kind, created at `at`. Accounts created at an earlier time come first.
 */
export const addFixtureAccount = (
  provider: keyof typeof FIXTURE_PROVIDERS,
  label: string | null = null,
  at?: string,
): Effect.Effect<StoredProviderAccount, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const accounts = yield* providerAccountRepository;
    const fixture = FIXTURE_PROVIDERS[provider];
    return yield* withTransaction(
      sql,
      accounts.insert({
        providerId: fixture.id,
        kind: fixture.kind,
        label,
        defaultHarnessId: fixture.harnessId,
        at: at ?? (yield* nowIso),
      }),
    );
  });

/** What a runner added by `addTextGenerationRunner` is like. Without traits it can take the call. */
export interface RunnerTraits {
  readonly reserved?: boolean;
  readonly online?: boolean;
  /** Whether the runner negotiated the text generation capability at hello. */
  readonly capable?: boolean;
}

/** Inserts a runner and returns its id. */
export const addTextGenerationRunner = (
  traits: RunnerTraits = {},
): Effect.Effect<string, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runners = yield* runnerRepository;
    return yield* withTransaction(
      sql,
      Effect.gen(function* () {
        const runner = yield* runners.insert({
          name: `runner-${crypto.randomUUID().slice(0, 4)}`,
          connectivity: traits.online === false ? "offline" : "online",
          lifecycle: "active",
          reserved: traits.reserved ?? false,
          labels: [],
          credentialHash: hashToken(crypto.randomUUID()),
          at: yield* nowIso,
        });
        const capabilities = traits.capable === false ? [] : [TEXT_GENERATION_CAPABILITY];
        yield* sql`UPDATE runners SET negotiated_capabilities = ${JSON.stringify(capabilities)}
          WHERE id = ${uuidFromString(runner.id)}`;
        return runner.id;
      }),
    );
  });

/** A probe result with the given sign-in status and model slugs. */
export const buildProbeResult = (
  status: "ok" | "unauthenticated",
  ...slugs: ReadonlyArray<string>
): ProbeResult => ({
  harnessVersion: "1.0.0",
  auth: { status },
  models: slugs.map((slug, index) => ({
    slug,
    name: slug,
    imageInput: { maxBytes: null },
    isDefault: index === 0,
    options: [],
  })),
});

/** Stores a runner's snapshot of an account in one of its harnesses. */
export const addSnapshot = (
  providerAccountId: string,
  harnessId: string,
  runnerId: string,
  result: ProbeResult,
): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const accounts = yield* providerAccountRepository;
    yield* withTransaction(
      sql,
      accounts.recordSnapshot(providerAccountId, harnessId, runnerId, result, yield* nowIso),
    );
  });
