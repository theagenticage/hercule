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
    displayName: "Anthropic",
    kinds: [
      {
        id: "subscription-per-machine",
        title: "Claude subscription",
        description: "Sign in with a Claude subscription on each machine.",
        setup: [{ kind: "harness-login" }],
        harnesses: ["claude-code/claude-code"],
      },
    ],
  },
  {
    id: "openai/openai",
    displayName: "OpenAI",
    kinds: [
      {
        id: "subscription-per-machine",
        title: "ChatGPT subscription",
        description: "Sign in with a ChatGPT subscription on each machine.",
        setup: [{ kind: "harness-login" }],
        harnesses: ["codex/codex"],
      },
    ],
  },
  {
    id: "zai/zai",
    displayName: "Z.ai",
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

const buildHarness = (id: string, displayName: string, binaryName: string): Harness => ({
  id,
  displayName,
  binaryName,
  declared: DECLARED,
  runners: [],
});

/** The harnesses of the shipped plugins, as `harness.query` lists them. */
export const HARNESSES: readonly Harness[] = [
  buildHarness("claude-code/claude-code", "Claude Code", "claude"),
  buildHarness("codex/codex", "Codex", "codex"),
  buildHarness("pi/pi", "pi", "pi"),
];

/** What makes a Provider Account this one: its own id, its provider and kind, its default harness and its label. */
export interface AccountIdentity {
  readonly id: string;
  readonly providerId: string;
  readonly kind: string;
  readonly harnessId: string;
  readonly label: string | null;
}

export const ANTHROPIC_IDENTITY: AccountIdentity = {
  id: "account-anthropic",
  providerId: "anthropic/anthropic",
  kind: "subscription-per-machine",
  harnessId: "claude-code/claude-code",
  label: null,
};

export const OPENAI_IDENTITY: AccountIdentity = {
  id: "account-openai",
  providerId: "openai/openai",
  kind: "subscription-per-machine",
  harnessId: "codex/codex",
  label: null,
};

export const ZAI_IDENTITY: AccountIdentity = {
  id: "account-zai",
  providerId: "zai/zai",
  kind: "api-key",
  harnessId: "pi/pi",
  label: null,
};

/**
 * Returns a Provider Account with the given identity. Every snapshot is
 * stamped with the account's default harness, so a test needs no harness id
 * on its snapshots; spread the result with its own `snapshots` for an account
 * with snapshots in another harness.
 */
export const buildProviderAccount = (
  identity: AccountIdentity,
  snapshots: ReadonlyArray<CapabilitySnapshot> = [],
): ProviderAccount => ({
  id: identity.id,
  providerId: identity.providerId,
  kind: identity.kind,
  label: identity.label,
  identity: null,
  planLabel: null,
  defaultHarnessId: identity.harnessId,
  snapshots: snapshots.map((snapshot) => ({ ...snapshot, harnessId: identity.harnessId })),
  createdAt: "2026-09-05T09:00:00.000Z",
  updatedAt: "2026-09-05T09:00:00.000Z",
});

/** Returns an account's capability snapshot on `BARE` in Claude Code, signed in unless `fields` overrides it. */
export const buildSnapshot = (fields: Partial<CapabilitySnapshot> = {}): CapabilitySnapshot => ({
  runnerId: BARE.id,
  harnessId: "claude-code/claude-code",
  probedAt: "2026-09-05T09:10:00.000Z",
  harnessVersion: "2.1.263",
  versionVerdict: "ok",
  auth: { status: "ok", identity: "rogier@example.com", planLabel: "Claude Max" },
  models: [{ slug: "default", name: "Default", imageInput: { maxBytes: null }, options: [] }],
  ...fields,
});
