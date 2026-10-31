/**
 * Test fixtures, not exported from the package index. The tests of
 * `buildProviderRows` and `decideSessionsEmptyState` use the same runner, so
 * they share these fixtures. So do the tests of every module that names or
 * sorts Provider Accounts.
 */
import type {
  CapabilitySnapshot,
  Harness,
  Provider,
  ProviderAccount,
  Runner,
} from "@hercule/contract";

const GIB = 1024 * 1024 * 1024;

export const BARE: Runner = {
  id: "01a06d02-beff-7037-9f5b-042822015952",
  name: "moss",
  connectivity: "online",
  lifecycle: "active",
  reserved: false,
  version: "0.4.2",
  labels: [],
  facts: {
    os: "darwin",
    arch: "arm64",
    totalMemoryBytes: 64 * GIB,
    docker: true,
    toolchains: [],
    harnesses: [
      { name: "claude", present: false },
      { name: "codex", present: false },
      { name: "pi", present: false },
    ],
    adapters: ["claude-code/claude-code"],
    identityPort: 4939,
  },
  watermark: null,
  maxConcurrentSessions: 4,
  diskWatermarkBytes: 10 * GIB,
  lastSeenAt: "2026-09-05T09:14:00.000Z",
};

export const WITH_CLAUDE: Runner = {
  ...BARE,
  facts: {
    ...BARE.facts!,
    harnesses: [
      { name: "claude", present: true, path: "/usr/local/bin/claude" },
      { name: "codex", present: false },
      { name: "pi", present: false },
    ],
  },
};

/** A runner with Claude Code and Codex installed, and a build that can drive both. */
export const WITH_AGENTS: Runner = {
  ...BARE,
  facts: {
    ...BARE.facts!,
    harnesses: [
      { name: "claude", present: true, path: "/usr/local/bin/claude" },
      { name: "codex", present: true, path: "/usr/local/bin/codex" },
      { name: "pi", present: false },
    ],
    adapters: ["claude-code/claude-code", "codex/codex"],
  },
};

const DECLARED: Harness["declared"] = {
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
};

/** The providers of the shipped plugins, as `provider.query` lists them. */
export const PROVIDERS: readonly Provider[] = [
  {
    id: "anthropic/anthropic",
    pluginId: "anthropic",
    displayName: "Anthropic",
    defaultHarnessId: "claude-code/claude-code",
    kinds: [
      {
        id: "subscription-per-machine",
        title: "Claude subscription",
        description: "Sign in with a Claude subscription on each machine.",
        setup: [{ kind: "harness-login", method: "sign-in" }],
        harnesses: ["claude-code/claude-code"],
      },
    ],
  },
  {
    id: "openai/openai",
    pluginId: "openai",
    displayName: "OpenAI",
    defaultHarnessId: "codex/codex",
    kinds: [
      {
        id: "subscription-per-machine",
        title: "ChatGPT subscription",
        description: "Sign in with a ChatGPT subscription on each machine.",
        setup: [{ kind: "harness-login", method: "sign-in" }],
        harnesses: ["codex/codex"],
      },
    ],
  },
  {
    id: "zai/zai",
    pluginId: "zai",
    displayName: "Z.ai",
    defaultHarnessId: "pi/pi",
    kinds: [
      {
        id: "api-key",
        title: "API key",
        description: "A Z.ai API key.",
        setup: [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }],
        harnesses: ["pi/pi"],
      },
    ],
  },
];

const buildHarness = (
  id: string,
  displayName: string,
  binaryName: string,
  runs: Harness["runs"],
): Harness => ({
  id,
  displayName,
  binaryName,
  declared: DECLARED,
  runs,
  runners: [],
});

/** The harnesses of the shipped plugins, as `harness.query` lists them. */
export const HARNESSES: readonly Harness[] = [
  buildHarness("claude-code/claude-code", "Claude Code", "claude", [
    {
      providerId: "anthropic/anthropic",
      kinds: [{ kind: "subscription-per-machine" }],
      modelArgument: "{model}",
      models: "all",
    },
  ]),
  buildHarness("codex/codex", "Codex", "codex", [
    {
      providerId: "openai/openai",
      kinds: [{ kind: "subscription-per-machine" }],
      modelArgument: "{model}",
      models: "all",
    },
  ]),
  buildHarness("pi/pi", "pi", "pi", [
    {
      providerId: "zai/zai",
      kinds: [{ kind: "api-key", credentialVariable: "ZAI_API_KEY" }],
      modelArgument: "zai/{model}",
      models: "own-list",
    },
  ]),
];

/** What makes a Provider Account this one: its own id, its provider and kind, its default harness and its label. */
export interface ProviderAccountIdentity {
  readonly id: string;
  readonly providerId: string;
  readonly kind: string;
  readonly harnessId: string;
  readonly label: string | null;
}

export const ANTHROPIC_IDENTITY: ProviderAccountIdentity = {
  id: "account-anthropic",
  providerId: "anthropic/anthropic",
  kind: "subscription-per-machine",
  harnessId: "claude-code/claude-code",
  label: null,
};

export const OPENAI_IDENTITY: ProviderAccountIdentity = {
  id: "account-openai",
  providerId: "openai/openai",
  kind: "subscription-per-machine",
  harnessId: "codex/codex",
  label: null,
};

export const ZAI_IDENTITY: ProviderAccountIdentity = {
  id: "account-zai",
  providerId: "zai/zai",
  kind: "api-key",
  harnessId: "pi/pi",
  label: null,
};

/**
 * Returns a Provider Account with the given identity. A snapshot built
 * without a harness id (`harnessId: undefined`) is stamped with the account's
 * default harness; a snapshot that names a harness keeps it, so an account can
 * hold snapshots in several harnesses.
 */
export const buildProviderAccount = (
  identity: ProviderAccountIdentity,
  snapshots: ReadonlyArray<SnapshotDraft> = [],
): ProviderAccount => ({
  id: identity.id,
  providerId: identity.providerId,
  kind: identity.kind,
  label: identity.label,
  identity: null,
  planLabel: null,
  defaultHarnessId: identity.harnessId,
  expiresAt: null,
  usage: [],
  failure: null,
  snapshots: snapshots.map((snapshot) => ({
    ...snapshot,
    harnessId: snapshot.harnessId ?? identity.harnessId,
  })),
  createdAt: "2026-09-05T09:00:00.000Z",
  updatedAt: "2026-09-05T09:00:00.000Z",
});

/** A capability snapshot that may leave its harness open, for `buildProviderAccount` to fill in. */
export type SnapshotDraft = Omit<CapabilitySnapshot, "harnessId"> & { readonly harnessId?: string };

/**
 * Returns an account's capability snapshot on `BARE`, signed in unless
 * `fields` overrides it. A snapshot that names its harness in `fields` is a
 * complete `CapabilitySnapshot`. Otherwise it is a draft, and
 * `buildProviderAccount` stamps the account's default harness on it.
 */
export function buildSnapshot(
  fields: Partial<CapabilitySnapshot> & { readonly harnessId: string },
): CapabilitySnapshot;
export function buildSnapshot(fields?: Partial<CapabilitySnapshot>): SnapshotDraft;
export function buildSnapshot(fields: Partial<CapabilitySnapshot> = {}): SnapshotDraft {
  return {
    runnerId: BARE.id,
    probedAt: "2026-09-05T09:10:00.000Z",
    harnessVersion: "2.1.263",
    versionVerdict: "ok",
    auth: { status: "ok", identity: "rogier@example.com", planLabel: "Claude Max" },
    models: [{ slug: "default", name: "Default", imageInput: { maxBytes: null }, options: [] }],
    ...fields,
  };
}
