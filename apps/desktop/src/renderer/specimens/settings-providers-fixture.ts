/**
 * The records the Settings > Providers specimen (settings-providers.tsx)
 * seeds its query cache with, as the controller would return them: five
 * Provider Accounts on three machines, in the states the Accounts section
 * draws.
 *
 * - studio-mac is this Mac, with Claude Code and Codex installed. atlas is a
 *   server with Claude Code only, so a Codex account offers Install there.
 *   moss is offline. old-box is retired, so no card and no sheet lists it.
 * - Anthropic is signed in on studio-mac and atlas, not on moss.
 * - Anthropic · Work is signed in on studio-mac only.
 * - OpenAI is signed in on studio-mac; OpenAI · Personal is signed in
 *   nowhere and knows no identity yet.
 * - Z.ai is an API key every machine uses. Its label is long, to show the
 *   name ending in an ellipsis.
 * - Each plugin declares the mark the shipped plugin declares: the book's
 *   brand path scaled by 2/3 onto the 16-unit grid a plugin's mark uses.
 */
import type { AccountKind, PluginMark, Provider, ProviderAccount, Runner } from "@hercule/contract";
import { buildRunner } from "@hercule/client-core/threads/testing";
import { SPECIMEN_RECORDS } from "./sidebar-fixture";
import type { ProvidersSettingsRecords, SidebarRecords } from "./shell-page";
import { buildPlugin } from "./plugins-fixture";

const ANTHROPIC_MARK: PluginMark = {
  paths: [
    "M11.536067 2.360667h-2.447867l4.464 11.278667H16Zm-7.072133 0L0 13.639333h2.496133l0.912867 -2.368467h4.670133l0.912867 2.368533h2.496133L7.0242 2.3606Zm-0.247467 6.815467 1.5276 -3.963733 1.5276 3.963733Z",
  ],
};
const OPENAI_MARK: PluginMark = {
  paths: [
    "M14.8546 6.5474a3.9898 3.9898 0 0 0 -0.3438 -3.273867 4.0308 4.0308 0 0 0 -4.339867 -1.933333A4.0434 4.0434 0 0 0 3.320467 2.787867a3.9898 3.9898 0 0 0 -2.665133 1.933333 4.0308 4.0308 0 0 0 0.495133 4.731067 3.986667 3.986667 0 0 0 0.340667 3.2738 4.034 4.034 0 0 0 4.343067 1.9334A3.9898 3.9898 0 0 0 8.839933 16a4.037133 4.037133 0 0 0 3.847867 -2.803867 3.992933 3.992933 0 0 0 2.665133 -1.9334 4.037133 4.037133 0 0 0 -0.498333 -4.715267zm-6.014667 8.4054a2.983667 2.983667 0 0 1 -1.9176 -0.693867l0.0946 -0.0536 3.185533 -1.8388a0.529867 0.529867 0 0 0 0.2618 -0.4542v-4.491267l1.346667 0.779067a0.047333 0.047333 0 0 1 0.025333 0.034667v3.721733a3.002667 3.002667 0 0 1 -2.996333 2.996267zm-6.440467 -2.750267a2.980533 2.980533 0 0 1 -0.3564 -2.009133l0.094667 0.0568 3.188667 1.8388a0.514133 0.514133 0 0 0 0.5204 0l3.8952 -2.245667v1.554933a0.0536 0.0536 0 0 1 -0.022133 0.041L6.493333 13.300133a2.999467 2.999467 0 0 1 -4.093867 -1.0976zM1.560533 5.263733a2.99 2.99 0 0 1 1.577 -1.3152V7.733333a0.510933 0.510933 0 0 0 0.2586 0.451l3.876267 2.2362 -1.346733 0.779a0.050467 0.050467 0 0 1 -0.047333 0l-3.2202 -1.857667A3.002667 3.002667 0 0 1 1.560533 5.248zm11.0642 2.570533L8.735867 5.576 10.079467 4.8a0.050467 0.050467 0 0 1 0.047333 0l3.2202 1.860867a2.996267 2.996267 0 0 1 -0.451 5.4028v-3.7848a0.526667 0.526667 0 0 0 -0.271333 -0.444667zm1.340467 -2.0154l-0.094667 -0.0568 -3.182333 -1.854533a0.517267 0.517267 0 0 0 -0.5236 0L6.272667 6.153133V4.598267a0.044133 0.044133 0 0 1 0.018933 -0.041l3.2202 -1.857733a2.999467 2.999467 0 0 1 4.453467 3.106667zM5.537667 8.575333l-1.346667 -0.775867a0.0536 0.0536 0 0 1 -0.025333 -0.0378V4.049467a2.999467 2.999467 0 0 1 4.917133 -2.302467l-0.094667 0.053667L5.802667 3.639333a0.529867 0.529867 0 0 0 -0.2618 0.4542zm0.731733 -1.576933l1.734667 -0.999867 1.737933 0.999867v1.9996l-1.7316 0.9998 -1.7378 -0.9998Z",
  ],
};
const ZAI_MARK: PluginMark = {
  paths: ["M3 2.333333h10v2.2L6.6 11.466667h6.4v2.2h-10v-2.2l6.4 -6.933333H3z"],
};

const AT = "2026-09-10T09:00:00.000Z";

/** Returns facts for a machine with the harnesses named `installed` on its PATH, and all three adapters. */
const buildFacts = (installed: ReadonlyArray<string>): NonNullable<Runner["facts"]> => ({
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 64 * 1024 * 1024 * 1024,
  docker: true,
  toolchains: [],
  harnesses: ["claude", "codex", "pi"].map((name) =>
    installed.includes(name)
      ? { name, present: true, path: `/opt/homebrew/bin/${name}` }
      : { name, present: false },
  ),
  adapters: ["claude-code/claude-code", "codex/codex", "pi/pi"],
  identityPort: 4939,
});

/** The user's own Mac, online, with Claude Code and Codex. */
const STUDIO_MAC: Runner = {
  ...buildRunner("r-studio-mac", "studio-mac"),
  facts: buildFacts(["claude", "codex"]),
};
/** A server, online, with Claude Code only. */
const ATLAS: Runner = { ...buildRunner("r-atlas", "atlas"), facts: buildFacts(["claude"]) };
/** A server that is switched off. */
const MOSS: Runner = {
  ...buildRunner("r-moss", "moss"),
  connectivity: "offline",
  facts: buildFacts(["claude", "codex"]),
};
/** A machine the user retired. */
const OLD_BOX: Runner = { ...buildRunner("r-old-box", "old-box"), lifecycle: "retired" };

/** Returns the snapshot of an account in `harnessId` on `runner`, signed in as `identity` or not signed in. */
const buildSnapshot = (
  runner: Runner,
  harnessId: string,
  identity: string | null,
  planLabel?: string,
): ProviderAccount["snapshots"][number] => ({
  runnerId: runner.id,
  harnessId,
  probedAt: AT,
  harnessVersion: null,
  versionVerdict: "unknown",
  auth:
    identity === null
      ? { status: "unauthenticated" }
      : { status: "ok", identity, ...(planLabel === undefined ? {} : { planLabel }) },
  models: [],
});

/** The five accounts, in the order they were added. */
export const PROVIDER_ACCOUNTS: ReadonlyArray<ProviderAccount> = [
  {
    id: "a-anthropic",
    providerId: "anthropic/anthropic",
    kind: "subscription-per-machine",
    label: null,
    identity: "rogier@acme.com",
    planLabel: "Max",
    defaultHarnessId: "claude-code/claude-code",
    expiresAt: null,
    snapshots: [
      buildSnapshot(STUDIO_MAC, "claude-code/claude-code", "rogier@acme.com", "Max"),
      buildSnapshot(ATLAS, "claude-code/claude-code", "rogier@acme.com", "Max"),
      buildSnapshot(MOSS, "claude-code/claude-code", null),
    ],
    createdAt: AT,
    updatedAt: AT,
  },
  {
    id: "a-anthropic-work",
    providerId: "anthropic/anthropic",
    kind: "subscription-per-machine",
    label: "Work",
    identity: "rogier@work.example",
    planLabel: "Team",
    defaultHarnessId: "claude-code/claude-code",
    expiresAt: null,
    snapshots: [
      buildSnapshot(STUDIO_MAC, "claude-code/claude-code", "rogier@work.example", "Team"),
      buildSnapshot(ATLAS, "claude-code/claude-code", null),
    ],
    createdAt: AT,
    updatedAt: AT,
  },
  {
    id: "a-openai",
    providerId: "openai/openai",
    kind: "subscription-per-machine",
    label: null,
    identity: "rogier@acme.com",
    planLabel: "Pro",
    defaultHarnessId: "codex/codex",
    expiresAt: null,
    snapshots: [buildSnapshot(STUDIO_MAC, "codex/codex", "rogier@acme.com", "Pro")],
    createdAt: AT,
    updatedAt: AT,
  },
  {
    id: "a-openai-personal",
    providerId: "openai/openai",
    kind: "subscription-per-machine",
    label: "Personal",
    identity: null,
    planLabel: null,
    defaultHarnessId: "codex/codex",
    expiresAt: null,
    snapshots: [],
    createdAt: AT,
    updatedAt: AT,
  },
  {
    id: "a-zai",
    providerId: "zai/zai",
    kind: "api-key",
    label: "Coding plan for the platform team",
    identity: null,
    planLabel: null,
    defaultHarnessId: "pi/pi",
    expiresAt: null,
    snapshots: [],
    createdAt: AT,
    updatedAt: AT,
  },
];

/** The kinds the add-account specimens draw, one of each way an account gets its credential. */
const KEY_FIELD = {
  name: "apiKey",
  label: "API key",
  help: "Create one in the Z.ai console, under API keys.",
};

export const SPECIMEN_KINDS: Readonly<Record<string, AccountKind>> = {
  token: {
    id: "subscription-token",
    title: "Claude subscription, every machine",
    description:
      "Sign in once and every machine uses it, also the ones you add later. The token lasts a year.",
    setup: [{ kind: "harness-login", method: "create-token" }],
    harnesses: ["claude-code/claude-code"],
  },
  perMachine: {
    id: "subscription-per-machine",
    title: "Claude subscription, signed in on each machine",
    description: "Sign in on every machine you want to use it on. Nothing is shared between them.",
    setup: [{ kind: "harness-login", method: "sign-in" }],
    harnesses: ["claude-code/claude-code"],
  },
  anthropicKey: {
    id: "api-key",
    title: "API key",
    description: "Pay per use with a key from the Anthropic console.",
    setup: [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }],
    harnesses: ["claude-code/claude-code", "pi/pi"],
  },
  openaiPerMachine: {
    id: "subscription-per-machine",
    title: "ChatGPT subscription, signed in on each machine",
    description:
      "Uses your ChatGPT plan through Codex. You sign in to Codex once on each machine that runs it.",
    setup: [{ kind: "harness-login", method: "sign-in" }],
    harnesses: ["codex/codex"],
  },
  openaiKey: {
    id: "api-key",
    title: "API key",
    description:
      "From the OpenAI platform. It is stored on the controller and sent to whichever machine runs a thread, so it is entered once and works on every machine.",
    setup: [{ kind: "credentials", fields: [{ name: "apiKey", label: "API key" }] }],
    harnesses: ["codex/codex", "pi/pi"],
  },
  zaiKey: {
    id: "api-key",
    title: "API key",
    description: "A Z.ai API key.",
    setup: [{ kind: "credentials", fields: [KEY_FIELD] }],
    harnesses: ["pi/pi"],
  },
};

export const SPECIMEN_PROVIDERS: ReadonlyArray<Provider> = [
  {
    id: "anthropic/anthropic",
    pluginId: "anthropic",
    displayName: "Anthropic",
    defaultHarnessId: "claude-code/claude-code",
    kinds: [SPECIMEN_KINDS.token!, SPECIMEN_KINDS.perMachine!, SPECIMEN_KINDS.anthropicKey!],
  },
  {
    id: "openai/openai",
    pluginId: "openai",
    displayName: "OpenAI",
    defaultHarnessId: "codex/codex",
    kinds: [SPECIMEN_KINDS.openaiPerMachine!, SPECIMEN_KINDS.openaiKey!],
  },
  {
    id: "zai/zai",
    pluginId: "zai",
    displayName: "Z.ai",
    defaultHarnessId: "pi/pi",
    kinds: [SPECIMEN_KINDS.zaiKey!],
  },
];

/**
 * The records the specimen draws beside the section: the sidebar of the
 * Bureau book, with the accounts, the machines and the plugins whose marks
 * name the providers.
 */
export const PROVIDERS_SIDEBAR_RECORDS: SidebarRecords = {
  ...SPECIMEN_RECORDS,
  threads: SPECIMEN_RECORDS.threads.slice(0, 4),
  runners: [STUDIO_MAC, ATLAS, MOSS, OLD_BOX],
  accounts: PROVIDER_ACCOUNTS,
  plugins: [
    buildPlugin("anthropic", "Anthropic", ANTHROPIC_MARK),
    buildPlugin("openai", "OpenAI", OPENAI_MARK),
    buildPlugin("zai", "Z.ai", ZAI_MARK),
  ],
};

/** What the section reads besides the sidebar's lists: which machine is this Mac. */
export const PROVIDERS_SETTINGS_RECORDS: ProvidersSettingsRecords = {
  thisMacRunnerId: STUDIO_MAC.id,
  providers: SPECIMEN_PROVIDERS,
  controllerRunnerId: STUDIO_MAC.id,
  createdAccount: {
    id: "01a06d02-8000-7000-8000-0000000000c2",
    providerId: "anthropic/anthropic",
    kind: "subscription-per-machine",
    label: "Home",
    identity: null,
    planLabel: null,
    defaultHarnessId: "claude-code/claude-code",
    expiresAt: null,
    snapshots: [],
    createdAt: AT,
    updatedAt: AT,
  },
};
