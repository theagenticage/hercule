/**
 * Fixtures for tests that run text generation on a real database and the real
 * plugin host. The plugins are the shipped ones, so a test sees the providers,
 * harnesses and suggested models `automatic` chooses between in production:
 *
 * - `openai/openai` (subscription per machine), run by `codex/codex`;
 * - `zai/zai` (API key), run by `pi/pi`;
 * - `anthropic/anthropic` (subscription per machine), run by
 *   `claude-code/claude-code`.
 */
import { Effect } from "effect";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import { anthropic } from "@hercule/plugin-anthropic";
import { claudeCode } from "@hercule/plugin-claude-code";
import { codex } from "@hercule/plugin-codex";
import { openai } from "@hercule/plugin-openai";
import { pi } from "@hercule/plugin-pi";
import { zai } from "@hercule/plugin-zai";
import type { Plugin } from "@hercule/plugin-host";
import { TEXT_GENERATION_CAPABILITY, type ProbeResult } from "@hercule/protocol";
import { nowIso, uuidFromString, withTransaction } from "../db";
import {
  modelCatalogRepository,
  providerAccountRepository,
  type StoredProviderAccount,
} from "../provider-accounts";
import { runnerRepository } from "../runners";
import { buildProviderAccountOwner, Secrets } from "../secrets";
import { hashToken } from "../credentials";

export const SUBSCRIPTION_KIND = "subscription-per-machine";
export const API_KEY_KIND = "api-key";

/** One shipped provider: its qualified id, the harness that runs it, its account kind and suggested model. */
interface FixtureProvider {
  readonly id: string;
  readonly harnessId: string;
  readonly kind: string;
  readonly suggestedModel: string;
}

export const FIXTURE_PROVIDERS: Readonly<Record<"openai" | "zai" | "anthropic", FixtureProvider>> =
  {
    openai: {
      id: "openai/openai",
      harnessId: "codex/codex",
      kind: SUBSCRIPTION_KIND,
      suggestedModel: "gpt-6-luna",
    },
    zai: {
      id: "zai/zai",
      harnessId: "pi/pi",
      kind: API_KEY_KIND,
      suggestedModel: "glm-5.3-flash",
    },
    anthropic: {
      id: "anthropic/anthropic",
      harnessId: "claude-code/claude-code",
      kind: SUBSCRIPTION_KIND,
      suggestedModel: "haiku",
    },
  };

/** Returns the plugins to boot: the three shipped providers and the three harnesses that run them. */
export const buildTextGenerationPlugins = (): ReadonlyArray<Plugin> => [
  anthropic,
  openai,
  zai,
  claudeCode,
  codex,
  pi,
];

/**
 * Inserts an account of a fixture provider, in the provider's own harness and
 * kind, created at `at`. Accounts created at an earlier time come first. A key
 * account gets a stored key, so it can run wherever its harness is installed.
 */
export const addFixtureAccount = (
  provider: keyof typeof FIXTURE_PROVIDERS,
  label: string | null = null,
  at?: string,
): Effect.Effect<StoredProviderAccount, unknown, SqlClient.SqlClient | Secrets> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const accounts = yield* providerAccountRepository;
    const secrets = yield* Secrets;
    const fixture = FIXTURE_PROVIDERS[provider];
    const account = yield* withTransaction(
      sql,
      accounts.insert({
        providerId: fixture.id,
        kind: fixture.kind,
        label,
        defaultHarnessId: fixture.harnessId,
        at: at ?? (yield* nowIso),
      }),
    );
    if (fixture.kind === API_KEY_KIND) {
      yield* withTransaction(
        sql,
        secrets.set(
          buildProviderAccountOwner(account.id),
          "apiKey",
          Redacted.make("a-fixture-key"),
        ),
      );
    }
    return account;
  });

/** What a runner added by `addTextGenerationRunner` is like. Without traits it can take the call. */
export interface RunnerTraits {
  readonly reserved?: boolean;
  readonly online?: boolean;
  /** Whether the runner negotiated the text generation capability at hello. */
  readonly capable?: boolean;
  /** False leaves the three fixture harnesses uninstalled on the runner. */
  readonly harnessesInstalled?: boolean;
}

/** Inserts a runner whose facts show the three fixture harnesses installed, and returns its id. */
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
        yield* runners.recordFacts(
          runner.id,
          {
            os: "linux",
            arch: "x64",
            totalMemoryBytes: 8 * 1024 ** 3,
            docker: false,
            toolchains: [],
            harnesses: ["claude", "codex", "pi"].map((name) => ({
              name,
              present: traits.harnessesInstalled !== false,
            })),
            adapters: Object.values(FIXTURE_PROVIDERS).map((one) => one.harnessId),
            identityPort: 4937,
          },
          yield* nowIso,
        );
        const capabilities = traits.capable === false ? [] : [TEXT_GENERATION_CAPABILITY];
        yield* sql`UPDATE runners SET negotiated_capabilities = ${JSON.stringify(capabilities)}
          WHERE id = ${uuidFromString(runner.id)}`;
        return runner.id;
      }),
    );
  });

/**
 * A probe result with the given sign-in status and model slugs. The harness
 * version is unknown, which passes the version floor the real harnesses have.
 */
export const buildProbeResult = (
  status: "ok" | "unauthenticated",
  ...slugs: ReadonlyArray<string>
): ProbeResult => ({
  harnessVersion: null,
  auth: { status },
  models: slugs.map((slug, index) => ({
    slug,
    name: slug,
    imageInput: { maxBytes: null },
    isDefault: index === 0,
    options: [],
  })),
  usage: null,
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

/**
 * Stores a successful Model Catalog read for an account, listing the models
 * of `result`, which is what `automatic` looks the suggested model up in.
 */
export const addCatalog = (
  providerAccountId: string,
  result: ProbeResult,
): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const catalogs = yield* modelCatalogRepository;
    const at = yield* nowIso;
    yield* withTransaction(sql, catalogs.recordSuccess(providerAccountId, result.models, at, at));
  });
