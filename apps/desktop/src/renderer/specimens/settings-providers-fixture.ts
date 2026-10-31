/**
 * The records the Settings > Providers specimen (settings-providers.tsx)
 * seeds its query cache with, as the controller would return them: nine
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
 *   name ending in an ellipsis. It reports no usage, so its card has no gauge.
 * - The usage and the expiry are relative to the time the page loads, so the
 *   page shows the same states on any day. Anthropic has a five-hour and a
 *   weekly window; Anthropic · Work has one at 85%, which turns marigold;
 *   OpenAI has a five-hour window that is hit; OpenAI · Team has a weekly
 *   window and credit left.
 * - Anthropic · Token expires in 12 days, and Anthropic · Old token has
 *   expired. OpenAI · API holds a key OpenAI refused. OpenAI · Personal is
 *   signed in nowhere, so its card says it is signed out.
 * - Each plugin declares the mark the shipped plugin declares: the book's
 *   brand path scaled by 2/3 onto the 16-unit grid a plugin's mark uses.
 */
import type {
  AccountKind,
  Harness,
  ModelCatalog,
  ModelProfile,
  PluginDetail,
  PluginMark,
  Provider,
  ProviderAccount,
  Runner,
} from "@hercule/contract";
import { buildRunner } from "@hercule/client-core/threads/testing";
import {
  buildModelProfile,
  buildProfileEntry,
  buildProfileSection,
  HARNESSES,
  type ProviderAccountIdentity,
} from "@hercule/client-core/testing";
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

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** The time the page loads, which the readings and the expiries are counted from. */
const LOADED_AT = Date.now();
const minutesAgo = (minutes: number): string =>
  new Date(LOADED_AT - minutes * MINUTE_MS).toISOString();
const inDays = (days: number): string => new Date(LOADED_AT + days * DAY_MS).toISOString();
const inHours = (hours: number): string =>
  new Date(LOADED_AT + hours * 60 * MINUTE_MS).toISOString();

/** Returns a usage window as a session reported it eight minutes ago. */
const buildWindow = (
  window: "five-hour" | "weekly" | "monthly",
  usedPercent: number,
  resetsAt: string,
  hit = false,
): ProviderAccount["usage"][number] => ({
  kind: "window",
  window,
  usedPercent,
  resetsAt,
  hit,
  takenAt: minutesAgo(8),
  source: "session",
});

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

/** The plugins that register the Providers, with the marks the accounts and the model menu draw. */
export const PROVIDER_PLUGINS: ReadonlyArray<PluginDetail> = [
  buildPlugin("anthropic", "Anthropic", ANTHROPIC_MARK),
  buildPlugin("openai", "OpenAI", OPENAI_MARK),
  buildPlugin("zai", "Z.ai", ZAI_MARK),
];

/** A Provider Account before it is given its Model Catalog facts and readiness. */
type AccountWithoutCatalog = Omit<
  ProviderAccount,
  "modelCount" | "catalogReadAt" | "catalogError" | "readiness"
>;

/**
 * Returns `account` with its Model Catalog facts and readiness. A signed-in
 * snapshot is a ready account on its runner and any other snapshot is not
 * signed in; an account that has been signed in has read its catalog.
 */
const withCatalog = (account: AccountWithoutCatalog): ProviderAccount => {
  const signedIn = account.snapshots.some((snapshot) => snapshot.auth.status === "ok");
  return {
    ...account,
    modelCount: signedIn ? 4 : 0,
    catalogReadAt: signedIn ? AT : null,
    catalogError: null,
    readiness: account.snapshots.map((snapshot) => ({
      harnessId: snapshot.harnessId,
      runnerId: snapshot.runnerId,
      state: snapshot.auth.status === "ok" ? "ready" : "not-signed-in",
    })),
  };
};

/** The nine accounts, in the order they were added. */
export const PROVIDER_ACCOUNTS: ReadonlyArray<ProviderAccount> = (
  [
    {
      id: "01a06d02-8000-7000-8000-000000000a01",
      providerId: "anthropic/anthropic",
      kind: "subscription-per-machine",
      label: null,
      identity: "rogier@acme.com",
      planLabel: "Max",
      defaultHarnessId: "claude-code/claude-code",
      expiresAt: null,
      usage: [buildWindow("five-hour", 61, inHours(3)), buildWindow("weekly", 38, inDays(3))],
      failure: null,
      snapshots: [
        buildSnapshot(STUDIO_MAC, "claude-code/claude-code", "rogier@acme.com", "Max"),
        buildSnapshot(ATLAS, "claude-code/claude-code", "rogier@acme.com", "Max"),
        buildSnapshot(MOSS, "claude-code/claude-code", null),
      ],
      createdAt: AT,
      updatedAt: AT,
    },
    {
      id: "01a06d02-8000-7000-8000-000000000a02",
      providerId: "anthropic/anthropic",
      kind: "subscription-per-machine",
      label: "Work",
      identity: "rogier@work.example",
      planLabel: "Team",
      defaultHarnessId: "claude-code/claude-code",
      expiresAt: null,
      usage: [buildWindow("five-hour", 85, inHours(1)), buildWindow("weekly", 41, inDays(2))],
      failure: null,
      snapshots: [
        buildSnapshot(STUDIO_MAC, "claude-code/claude-code", "rogier@work.example", "Team"),
        buildSnapshot(ATLAS, "claude-code/claude-code", null),
      ],
      createdAt: AT,
      updatedAt: AT,
    },
    {
      id: "01a06d02-8000-7000-8000-000000000a03",
      providerId: "openai/openai",
      kind: "subscription-per-machine",
      label: null,
      identity: "rogier@acme.com",
      planLabel: "Pro",
      defaultHarnessId: "codex/codex",
      expiresAt: null,
      usage: [
        buildWindow("five-hour", 100, inHours(2), true),
        buildWindow("weekly", 72, inDays(4)),
      ],
      failure: null,
      snapshots: [buildSnapshot(STUDIO_MAC, "codex/codex", "rogier@acme.com", "Pro")],
      createdAt: AT,
      updatedAt: AT,
    },
    {
      id: "01a06d02-8000-7000-8000-000000000a04",
      providerId: "openai/openai",
      kind: "subscription-per-machine",
      label: "Personal",
      identity: null,
      planLabel: null,
      defaultHarnessId: "codex/codex",
      expiresAt: null,
      usage: [],
      failure: null,
      snapshots: [],
      createdAt: AT,
      updatedAt: AT,
    },
    {
      id: "01a06d02-8000-7000-8000-000000000a05",
      providerId: "zai/zai",
      kind: "api-key",
      label: "Coding plan for the platform team",
      identity: null,
      planLabel: null,
      defaultHarnessId: "pi/pi",
      expiresAt: null,
      usage: [],
      failure: null,
      snapshots: [],
      createdAt: AT,
      updatedAt: AT,
    },
    {
      id: "01a06d02-8000-7000-8000-000000000a06",
      providerId: "openai/openai",
      kind: "subscription-per-machine",
      label: "Team",
      identity: "rogier@platform.example",
      planLabel: "Business",
      defaultHarnessId: "codex/codex",
      expiresAt: null,
      usage: [
        buildWindow("weekly", 54, inDays(5)),
        { kind: "credit", remaining: 1240, limit: 2000, takenAt: minutesAgo(8), source: "read" },
      ],
      failure: null,
      snapshots: [buildSnapshot(STUDIO_MAC, "codex/codex", "rogier@platform.example", "Business")],
      createdAt: AT,
      updatedAt: AT,
    },
    {
      id: "01a06d02-8000-7000-8000-000000000a07",
      providerId: "anthropic/anthropic",
      kind: "subscription-token",
      label: "Token",
      identity: "rogier@acme.com",
      planLabel: "Max",
      defaultHarnessId: "claude-code/claude-code",
      expiresAt: inDays(12),
      usage: [],
      failure: null,
      snapshots: [],
      createdAt: AT,
      updatedAt: AT,
    },
    {
      id: "01a06d02-8000-7000-8000-000000000a08",
      providerId: "anthropic/anthropic",
      kind: "subscription-token",
      label: "Old token",
      identity: "rogier@acme.com",
      planLabel: "Max",
      defaultHarnessId: "claude-code/claude-code",
      expiresAt: inDays(-3),
      usage: [],
      failure: null,
      snapshots: [],
      createdAt: AT,
      updatedAt: AT,
    },
    {
      id: "01a06d02-8000-7000-8000-000000000a09",
      providerId: "openai/openai",
      kind: "api-key",
      label: "API",
      identity: null,
      planLabel: null,
      defaultHarnessId: "codex/codex",
      expiresAt: null,
      usage: [],
      failure: { message: "Incorrect API key provided.", failedAt: minutesAgo(40) },
      snapshots: [],
      createdAt: AT,
      updatedAt: AT,
    },
  ] satisfies ReadonlyArray<AccountWithoutCatalog>
).map(withCatalog);

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

/** The identity the model profile's builders need of one of the accounts above. */
const identityOf = (id: string): ProviderAccountIdentity => {
  const account = PROVIDER_ACCOUNTS.find((each) => each.id === id)!;
  return {
    id,
    providerId: account.providerId,
    kind: account.kind,
    harnessId: account.defaultHarnessId,
    label: account.label,
  };
};
const ANTHROPIC = identityOf("01a06d02-8000-7000-8000-000000000a01");
const ANTHROPIC_WORK = identityOf("01a06d02-8000-7000-8000-000000000a02");
const OPENAI = identityOf("01a06d02-8000-7000-8000-000000000a03");
const OPENAI_PERSONAL = identityOf("01a06d02-8000-7000-8000-000000000a04");

/**
 * The one Model Profile, "Main": Anthropic with Opus 5.5 as the profile's
 * default; Anthropic's Work account with one model; OpenAI with a model that
 * also runs in pi; and OpenAI's Personal account, which has not read its
 * catalog yet, so its section waits.
 */
export const PROVIDER_MODEL_PROFILES: ReadonlyArray<ModelProfile> = [
  buildModelProfile(
    [
      buildProfileSection(ANTHROPIC, [
        buildProfileEntry(ANTHROPIC, "opus-5-5", { name: "Opus 5.5" }),
        buildProfileEntry(ANTHROPIC, "fable-5-1", { name: "Fable 5.1" }),
        buildProfileEntry(ANTHROPIC, "sonnet-5-5", { name: "Sonnet 5.5" }),
        buildProfileEntry(ANTHROPIC, "haiku-5-5", { name: "Haiku 5.5" }),
      ]),
      buildProfileSection(ANTHROPIC_WORK, [
        buildProfileEntry(ANTHROPIC_WORK, "opus-4-8", { name: "Opus 4.8" }),
      ]),
      buildProfileSection(OPENAI, [
        buildProfileEntry(OPENAI, "gpt-6-1-sol", { name: "GPT-6.1 Sol" }),
        buildProfileEntry(OPENAI, "gpt-6-luna", { name: "GPT-6 Luna" }),
        buildProfileEntry(OPENAI, "gpt-6-1-sol", {
          name: "GPT-6.1 Sol",
          harnessId: "pi/pi",
          resolvedHarnessId: "pi/pi",
        }),
      ]),
      buildProfileSection(OPENAI_PERSONAL, "pending"),
    ],
    {
      id: "01a06d02-8000-7000-8000-000000000b01",
      revision: 6,
      defaultEntry: { providerAccountId: ANTHROPIC.id, model: "opus-5-5", harnessId: null },
    },
  ),
];

/** What Anthropic's catalog holds, which its picker lists: the profile's four models, and an older one. */
export const ANTHROPIC_CATALOG: ModelCatalog = {
  providerAccountId: ANTHROPIC.id,
  readAt: AT,
  error: null,
  models: [
    ["opus-5-5", "Opus 5.5"],
    ["fable-5-1", "Fable 5.1"],
    ["sonnet-5-5", "Sonnet 5.5"],
    ["haiku-5-5", "Haiku 5.5"],
    ["opus-4-8", "Opus 4.8"],
  ].map(([slug, name]) => ({
    slug: slug!,
    name: name!,
    ...(slug === "opus-4-8" ? { isLegacy: true } : {}),
    imageInput: null,
    options: [],
    firstSeenAt: AT,
  })),
};

/**
 * The shared harnesses, with the kinds this page's accounts use added: Claude
 * Code runs Anthropic's token and key, and Codex runs OpenAI's key. Without
 * them the account sheet's Default harness would strike out the harness an
 * account of those kinds runs in.
 */
const SPECIMEN_HARNESSES: ReadonlyArray<Harness> = HARNESSES.map((harness) => {
  const extraKinds =
    harness.id === "claude-code/claude-code"
      ? [
          { kind: "subscription-token", credentialVariable: "CLAUDE_CODE_OAUTH_TOKEN" },
          { kind: "api-key", credentialVariable: "ANTHROPIC_API_KEY" },
        ]
      : harness.id === "codex/codex"
        ? [{ kind: "api-key", credentialVariable: "OPENAI_API_KEY" }]
        : [];
  return {
    ...harness,
    runs: harness.runs.map((run) => ({ ...run, kinds: [...run.kinds, ...extraKinds] })),
  };
});

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
  modelProfiles: PROVIDER_MODEL_PROFILES,
  plugins: PROVIDER_PLUGINS,
};

/** What the section reads besides the sidebar's lists: which machine is this Mac. */
export const PROVIDERS_SETTINGS_RECORDS: ProvidersSettingsRecords = {
  thisMacRunnerId: STUDIO_MAC.id,
  providers: SPECIMEN_PROVIDERS,
  harnesses: SPECIMEN_HARNESSES,
  controllerRunnerId: STUDIO_MAC.id,
  catalog: ANTHROPIC_CATALOG,
  createdAccount: withCatalog({
    id: "01a06d02-8000-7000-8000-0000000000c2",
    providerId: "anthropic/anthropic",
    kind: "subscription-per-machine",
    label: "Home",
    identity: null,
    planLabel: null,
    defaultHarnessId: "claude-code/claude-code",
    expiresAt: null,
    usage: [],
    failure: null,
    snapshots: [],
    createdAt: AT,
    updatedAt: AT,
  }),
};
