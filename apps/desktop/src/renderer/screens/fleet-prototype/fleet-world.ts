/**
 * PROTOTYPE - throwaway. The fixture world and the in-memory store behind the
 * Fleet page prototype (specimens/fleet-prototype.html). Nothing here talks to
 * a controller: every action waits a moment and then changes the state below.
 *
 * Fields marked NEW are not in the public API today (packages/contract,
 * groups/runner.ts and workspace.ts). They are what the design would need.
 */
import { useSyncExternalStore } from "react";

export type MachineId =
  | "atlas"
  | "beelink"
  | "studio-mac"
  | "hetzner-ax"
  | "foundry"
  | "office-mini";
export type ProjectId = "webshop" | "payments-api" | "ops";

export interface Machine {
  readonly id: MachineId;
  readonly name: string;
  readonly kind: "laptop" | "server";
  readonly model: string;
  readonly os: string;
  readonly platform: "macos" | "linux";
  readonly arch: string;
  readonly isLocal: boolean;
  readonly connectivity: "online" | "offline";
  /** When the controller last heard from it, as words. */
  readonly lastSeen: string;
  /** True when it stopped answering without signing off (the contract's `unreachable`). */
  readonly lostContact: boolean;
  readonly lifecycle: "active" | "draining";
  readonly runnerVersion: string;
  readonly labels: ReadonlyArray<string>;
  readonly reserved: boolean;
  readonly slots: number;
  readonly running: number;
  /** Threads waiting for a slot on this machine, because they resume here. */
  readonly queued: number;
  /** Threads pinned to this machine that cannot resume while it is away. */
  readonly pinned: number;
  readonly memoryTotalGB: number;
  readonly memoryFreeGB: number;
  /** NEW: the CPU load, as a percentage. */
  readonly cpu: number;
  /** NEW: the disk's size. The runner reports only what is free. */
  readonly diskTotalGB: number;
  readonly diskFreeGB: number;
  /** NEW: how much the free space changes a day, over the last two weeks. */
  readonly diskTrendGBPerDay: number;
  readonly diskWatermarkGB: number;
  /** NEW: what holds the disk besides the workspaces, which are counted from the workspaces. */
  readonly caches: number;
  readonly providerData: number;
  readonly logs: number;
}

export interface Workspace {
  readonly id: string;
  readonly machineId: MachineId;
  readonly project: ProjectId;
  readonly branch: string;
  readonly thread: string;
  readonly lastUsedDays: number;
  /** NEW: the size of the workspace's folder. */
  readonly sizeGB: number;
  /** NEW: how many files hold uncommitted changes. */
  readonly changes: number;
  readonly inUse: boolean;
}

export interface Project {
  readonly id: ProjectId;
  readonly name: string;
}

export interface Need {
  readonly project: ProjectId;
  /** What the project asks for, such as "22" or "1.25". */
  readonly range: string;
  /** NEW: the file in the repository the need was read from. */
  readonly source: string;
}

export interface Tool {
  readonly id: string;
  readonly name: string;
  readonly kind: "harness" | "runner" | "toolchain";
  /** The version Hercule installs: the newest the runner build supports, or the fleet's pin. */
  readonly target: string;
  readonly needs: ReadonlyArray<Need>;
  /** How Hercule installs it, or null when it must be installed by hand. */
  readonly via: { readonly macos: string | null; readonly linux: string | null };
  readonly blurb: string;
}

export interface Installed {
  readonly version: string;
  /** Who put it there: Hercule, for its sessions, or the machine's own package manager. */
  readonly source: "hercule" | "machine";
  readonly path: string;
}

export interface FleetState {
  readonly machines: ReadonlyArray<Machine>;
  /** NEW as one read: what runs on each machine, grouped by workspace. */
  readonly workloads: ReadonlyArray<Workload>;
  readonly workspaces: ReadonlyArray<Workspace>;
  readonly installed: Readonly<Record<string, Readonly<Partial<Record<MachineId, Installed>>>>>;
  /** Keys of the actions under way: `tool:<toolId>:<machineId>`, `cleanup:<machineId>`, `slots:<machineId>`. */
  readonly pending: ReadonlySet<string>;
  /** The last thing that finished, for the page's toast. */
  readonly toast: { readonly id: number; readonly text: string } | null;
  /** NEW: how Hercule keeps each tool, by tool id. */
  readonly policies: Readonly<Record<string, Policy>>;
  /** NEW: after how many idle days clean workspaces go by themselves, or "off". */
  readonly autoClean: AutoClean;
  /** NEW: what happened on each machine, newest first. */
  readonly activity: Readonly<Record<MachineId, ReadonlyArray<ActivityEntry>>>;
}

/**
 * How Hercule keeps a tool on every machine:
 *
 * - `newest`: the newest version this Hercule build supports;
 * - `pinned`: exactly the tool's target, until the user moves the pin;
 * - `hands-off`: Hercule reports what it finds, and never installs it.
 */
export type Policy = "newest" | "pinned" | "hands-off";

export type AutoClean = "off" | 30 | 60;

/**
 * One line of a machine's activity, drawn only from what the controller's
 * audit log records today (the `events` table): runner.stateChanged,
 * runner.joined, runner.updated, runner.drained, runner.placementsChanged,
 * workspace.deleted and its kin, session.spawned, session.stopped and
 * session.reconciled, and provider.loggedIn. Harness installs, version
 * changes and probes are not recorded, so they never show here.
 */
export interface ActivityEntry {
  readonly id: string;
  /** The day it happened, as the list heads its group: "Today", "Yesterday", "Sun 27 Sep". */
  readonly day: string;
  readonly time: string;
  readonly category: "connection" | "sessions" | "workspaces" | "settings";
  /** True for what someone diagnosing a problem looks for. */
  readonly problem: boolean;
  readonly text: string;
  /** Who did it: "you", "Hercule", or the session that acted. */
  readonly actor: string;
  /** The audit log kind behind the entry. */
  readonly source: string;
  /** For an entry that stands for several log entries, what each one was. */
  readonly items?: ReadonlyArray<string>;
}

export const PROJECTS: ReadonlyArray<Project> = [
  { id: "webshop", name: "webshop" },
  { id: "payments-api", name: "payments-api" },
  { id: "ops", name: "ops" },
];

/** The project tint tokens of tokens.css, by project. */
export const PROJECT_TINT: Readonly<Record<ProjectId, string>> = {
  webshop: "var(--proj-webshop)",
  "payments-api": "var(--proj-payments)",
  ops: "var(--proj-ops)",
};

export const CONTROLLER_VERSION = "0.4.2";

export const TOOLS: ReadonlyArray<Tool> = [
  {
    id: "claude-code",
    name: "Claude Code",
    kind: "harness",
    target: "2.6.14",
    needs: [],
    via: { macos: "Anthropic's installer", linux: "Anthropic's installer" },
    blurb: "Runs Claude models. Every thread on Claude starts it.",
  },
  {
    id: "codex",
    name: "Codex",
    kind: "harness",
    target: "0.94.0",
    needs: [],
    via: { macos: "OpenAI's installer", linux: "OpenAI's installer" },
    blurb: "Runs OpenAI models.",
  },
  {
    id: "pi",
    name: "Pi",
    kind: "harness",
    target: "0.52.3",
    needs: [],
    via: { macos: "npm", linux: "npm" },
    blurb: "Runs any model with an API key.",
  },
  {
    id: "runner",
    name: "Hercule runner",
    kind: "runner",
    target: CONTROLLER_VERSION,
    needs: [],
    via: { macos: "Hercule", linux: "Hercule" },
    blurb: "Hosts the sessions. Updates when no session runs.",
  },
  {
    id: "git",
    name: "git",
    kind: "toolchain",
    target: "2.51.0",
    needs: [
      { project: "webshop", range: "2", source: "every repository" },
      { project: "payments-api", range: "2", source: "every repository" },
      { project: "ops", range: "2", source: "every repository" },
    ],
    via: { macos: "Homebrew", linux: "mise" },
    blurb: "Every workspace is a git checkout.",
  },
  {
    id: "gh",
    name: "gh",
    kind: "toolchain",
    target: "2.83.1",
    needs: [],
    via: { macos: "Homebrew", linux: "mise" },
    blurb: "GitHub's CLI. Agents open pull requests with it.",
  },
  {
    id: "node",
    name: "node",
    kind: "toolchain",
    target: "22.20.0",
    needs: [{ project: "webshop", range: "22", source: ".nvmrc" }],
    via: { macos: "mise", linux: "mise" },
    blurb: "JavaScript runtime.",
  },
  {
    id: "pnpm",
    name: "pnpm",
    kind: "toolchain",
    target: "10.18.0",
    needs: [{ project: "webshop", range: "10", source: "package.json" }],
    via: { macos: "mise", linux: "mise" },
    blurb: "JavaScript package manager.",
  },
  {
    id: "go",
    name: "go",
    kind: "toolchain",
    target: "1.25.3",
    needs: [{ project: "payments-api", range: "1.25", source: "go.mod" }],
    via: { macos: "mise", linux: "mise" },
    blurb: "Go toolchain.",
  },
  {
    id: "docker",
    name: "docker",
    kind: "toolchain",
    target: "28.5.1",
    needs: [{ project: "payments-api", range: "28", source: "compose.yaml" }],
    via: { macos: null, linux: null },
    blurb: "Containers. Needs a daemon, so it is installed by hand.",
  },
  {
    id: "python",
    name: "python",
    kind: "toolchain",
    target: "3.13.7",
    needs: [{ project: "ops", range: "3.13", source: ".python-version" }],
    via: { macos: "mise", linux: "mise" },
    blurb: "Python interpreter.",
  },
  {
    id: "uv",
    name: "uv",
    kind: "toolchain",
    target: "0.9.2",
    needs: [{ project: "ops", range: "0.9", source: "pyproject.toml" }],
    via: { macos: "mise", linux: "mise" },
    blurb: "Python package manager.",
  },
  {
    id: "terraform",
    name: "terraform",
    kind: "toolchain",
    target: "1.13.4",
    needs: [{ project: "ops", range: "1.13", source: ".terraform-version" }],
    via: { macos: "mise", linux: "mise" },
    blurb: "Infrastructure as code.",
  },
];

export const TOOL_BY_ID: ReadonlyMap<string, Tool> = new Map(TOOLS.map((tool) => [tool.id, tool]));

const MACHINES: ReadonlyArray<Machine> = [
  {
    id: "atlas",
    name: "atlas",
    kind: "laptop",
    model: "MacBook Pro",
    os: "macOS 26.1",
    platform: "macos",
    arch: "arm64",
    isLocal: true,
    connectivity: "online",
    lastSeen: "now",
    lostContact: false,
    lifecycle: "active",
    runnerVersion: "0.4.2",
    labels: ["mac"],
    reserved: false,
    slots: 4,
    running: 2,
    queued: 0,
    pinned: 0,
    memoryTotalGB: 48,
    memoryFreeGB: 19.2,
    cpu: 31,
    diskTotalGB: 994,
    diskFreeGB: 288,
    diskTrendGBPerDay: -0.6,
    diskWatermarkGB: 10,
    caches: 9,
    providerData: 6,
    logs: 1,
  },
  {
    id: "beelink",
    name: "beelink",
    kind: "server",
    model: "Beelink SER8",
    os: "Ubuntu 24.04",
    platform: "linux",
    arch: "x64",
    isLocal: false,
    connectivity: "online",
    lastSeen: "now",
    lostContact: false,
    lifecycle: "active",
    runnerVersion: "0.4.2",
    labels: ["linux", "always-on"],
    reserved: false,
    slots: 13,
    running: 9,
    queued: 0,
    pinned: 0,
    memoryTotalGB: 32,
    memoryFreeGB: 8.3,
    cpu: 62,
    diskTotalGB: 938,
    diskFreeGB: 112,
    diskTrendGBPerDay: -9.2,
    diskWatermarkGB: 10,
    caches: 48,
    providerData: 31,
    logs: 3,
  },
  {
    id: "studio-mac",
    name: "studio-mac",
    kind: "server",
    model: "Mac Studio",
    os: "macOS 26.1",
    platform: "macos",
    arch: "arm64",
    isLocal: false,
    connectivity: "online",
    lastSeen: "now",
    lostContact: false,
    lifecycle: "active",
    runnerVersion: "0.4.2",
    labels: ["mac", "gpu"],
    reserved: false,
    slots: 8,
    running: 8,
    queued: 3,
    pinned: 0,
    memoryTotalGB: 128,
    memoryFreeGB: 75.5,
    cpu: 48,
    diskTotalGB: 1994,
    diskFreeGB: 1210,
    diskTrendGBPerDay: -2.1,
    diskWatermarkGB: 10,
    caches: 22,
    providerData: 14,
    logs: 2,
  },
  {
    id: "hetzner-ax",
    name: "hetzner-ax",
    kind: "server",
    model: "Hetzner AX52",
    os: "Debian 13",
    platform: "linux",
    arch: "x64",
    isLocal: false,
    connectivity: "online",
    lastSeen: "now",
    lostContact: false,
    lifecycle: "active",
    runnerVersion: "0.4.0",
    labels: ["linux", "cloud"],
    reserved: false,
    slots: 12,
    running: 3,
    queued: 0,
    pinned: 0,
    memoryTotalGB: 64,
    memoryFreeGB: 49.3,
    cpu: 14,
    diskTotalGB: 476,
    diskFreeGB: 301,
    diskTrendGBPerDay: -0.4,
    diskWatermarkGB: 10,
    caches: 16,
    providerData: 7,
    logs: 1,
  },
  {
    id: "foundry",
    name: "foundry",
    kind: "server",
    model: "Hetzner AX162",
    os: "Ubuntu 24.04",
    platform: "linux",
    arch: "x64",
    isLocal: false,
    connectivity: "online",
    lastSeen: "now",
    lostContact: false,
    lifecycle: "active",
    runnerVersion: "0.4.2",
    labels: ["linux", "cloud", "big"],
    reserved: false,
    slots: 96,
    running: 71,
    queued: 0,
    pinned: 0,
    memoryTotalGB: 384,
    memoryFreeGB: 176,
    cpu: 58,
    diskTotalGB: 3840,
    diskFreeGB: 2210,
    diskTrendGBPerDay: -6.5,
    diskWatermarkGB: 10,
    caches: 140,
    providerData: 96,
    logs: 6,
  },
  {
    id: "office-mini",
    name: "office-mini",
    kind: "server",
    model: "Mac mini",
    os: "macOS 15.6",
    platform: "macos",
    arch: "arm64",
    isLocal: false,
    connectivity: "offline",
    lastSeen: "Monday 14:02",
    lostContact: true,
    lifecycle: "active",
    runnerVersion: "0.4.1",
    labels: ["mac"],
    reserved: false,
    slots: 4,
    running: 0,
    queued: 0,
    pinned: 2,
    memoryTotalGB: 16,
    memoryFreeGB: 0,
    cpu: 0,
    diskTotalGB: 228,
    diskFreeGB: 61,
    diskTrendGBPerDay: 0,
    diskWatermarkGB: 10,
    caches: 6,
    providerData: 3,
    logs: 1,
  },
];

/** Which tools sit where, and how they got there. */
const at = (version: string, source: Installed["source"], path: string): Installed => ({
  version,
  source,
  path,
});
const INSTALLED: FleetState["installed"] = {
  "claude-code": {
    foundry: at("2.6.14", "hercule", "~/.local/bin/claude"),
    atlas: at("2.6.14", "hercule", "~/.local/bin/claude"),
    beelink: at("2.6.14", "hercule", "~/.local/bin/claude"),
    "studio-mac": at("2.6.9", "hercule", "~/.local/bin/claude"),
    "hetzner-ax": at("2.5.31", "hercule", "~/.local/bin/claude"),
    "office-mini": at("2.6.2", "hercule", "~/.local/bin/claude"),
  },
  codex: {
    foundry: at("0.94.0", "hercule", "~/.local/bin/codex"),
    atlas: at("0.94.0", "hercule", "~/.local/bin/codex"),
    beelink: at("0.93.1", "hercule", "~/.local/bin/codex"),
    "studio-mac": at("0.94.0", "hercule", "~/.local/bin/codex"),
    "office-mini": at("0.91.0", "hercule", "~/.local/bin/codex"),
  },
  pi: {
    foundry: at("0.52.3", "hercule", "~/.npm-global/bin/pi"),
    atlas: at("0.52.3", "hercule", "~/.npm-global/bin/pi"),
    beelink: at("0.52.3", "hercule", "~/.npm-global/bin/pi"),
  },
  runner: {
    foundry: at("0.4.2", "hercule", "~/.hercule/bin/hercule"),
    atlas: at("0.4.2", "hercule", "~/.hercule/bin/hercule"),
    beelink: at("0.4.2", "hercule", "~/.hercule/bin/hercule"),
    "studio-mac": at("0.4.2", "hercule", "~/.hercule/bin/hercule"),
    "hetzner-ax": at("0.4.0", "hercule", "~/.hercule/bin/hercule"),
    "office-mini": at("0.4.1", "hercule", "~/.hercule/bin/hercule"),
  },
  git: {
    foundry: at("2.51.0", "hercule", "~/.local/share/mise/installs/git/2.51.0"),
    atlas: at("2.51.0", "machine", "/opt/homebrew/bin/git"),
    beelink: at("2.43.0", "machine", "/usr/bin/git"),
    "studio-mac": at("2.51.0", "machine", "/opt/homebrew/bin/git"),
    "hetzner-ax": at("2.51.0", "hercule", "~/.local/share/mise/installs/git/2.51.0"),
    "office-mini": at("2.50.1", "machine", "/opt/homebrew/bin/git"),
  },
  gh: {
    foundry: at("2.83.1", "hercule", "~/.local/share/mise/installs/gh/2.83.1"),
    atlas: at("2.83.1", "machine", "/opt/homebrew/bin/gh"),
    beelink: at("2.83.1", "hercule", "~/.local/share/mise/installs/gh/2.83.1"),
    "studio-mac": at("2.83.1", "machine", "/opt/homebrew/bin/gh"),
    "hetzner-ax": at("2.81.0", "hercule", "~/.local/share/mise/installs/gh/2.81.0"),
    "office-mini": at("2.83.1", "machine", "/opt/homebrew/bin/gh"),
  },
  node: {
    foundry: at("22.20.0", "hercule", "~/.local/share/mise/installs/node/22.20.0"),
    atlas: at("22.20.0", "hercule", "~/.local/share/mise/installs/node/22.20.0"),
    beelink: at("22.20.0", "hercule", "~/.local/share/mise/installs/node/22.20.0"),
    "studio-mac": at("22.18.0", "machine", "/opt/homebrew/bin/node"),
    "hetzner-ax": at("22.20.0", "hercule", "~/.local/share/mise/installs/node/22.20.0"),
    "office-mini": at("22.18.0", "hercule", "~/.local/share/mise/installs/node/22.18.0"),
  },
  pnpm: {
    foundry: at("10.18.0", "hercule", "~/.local/share/mise/installs/pnpm/10.18.0"),
    atlas: at("10.18.0", "hercule", "~/.local/share/mise/installs/pnpm/10.18.0"),
    beelink: at("10.18.0", "hercule", "~/.local/share/mise/installs/pnpm/10.18.0"),
    "studio-mac": at("10.18.0", "hercule", "~/.local/share/mise/installs/pnpm/10.18.0"),
    "hetzner-ax": at("10.17.1", "hercule", "~/.local/share/mise/installs/pnpm/10.17.1"),
    "office-mini": at("10.18.0", "hercule", "~/.local/share/mise/installs/pnpm/10.18.0"),
  },
  go: {
    foundry: at("1.25.3", "hercule", "~/.local/share/mise/installs/go/1.25.3"),
    atlas: at("1.25.3", "hercule", "~/.local/share/mise/installs/go/1.25.3"),
    beelink: at("1.25.3", "hercule", "~/.local/share/mise/installs/go/1.25.3"),
    "hetzner-ax": at("1.25.1", "hercule", "~/.local/share/mise/installs/go/1.25.1"),
  },
  docker: {
    foundry: at("28.5.1", "machine", "/usr/bin/docker"),
    atlas: at("28.5.1", "machine", "/usr/local/bin/docker"),
    beelink: at("28.5.1", "machine", "/usr/bin/docker"),
    "hetzner-ax": at("28.5.1", "machine", "/usr/bin/docker"),
  },
  python: {
    foundry: at("3.13.7", "hercule", "~/.local/share/mise/installs/python/3.13.7"),
    atlas: at("3.13.7", "hercule", "~/.local/share/mise/installs/python/3.13.7"),
    beelink: at("3.12.3", "machine", "/usr/bin/python3"),
    "studio-mac": at("3.13.7", "hercule", "~/.local/share/mise/installs/python/3.13.7"),
    "hetzner-ax": at("3.13.7", "hercule", "~/.local/share/mise/installs/python/3.13.7"),
    "office-mini": at("3.13.5", "hercule", "~/.local/share/mise/installs/python/3.13.5"),
  },
  uv: {
    foundry: at("0.9.2", "hercule", "~/.local/share/mise/installs/uv/0.9.2"),
    atlas: at("0.9.2", "hercule", "~/.local/share/mise/installs/uv/0.9.2"),
    beelink: at("0.9.2", "hercule", "~/.local/share/mise/installs/uv/0.9.2"),
    "studio-mac": at("0.9.2", "hercule", "~/.local/share/mise/installs/uv/0.9.2"),
    "hetzner-ax": at("0.9.2", "hercule", "~/.local/share/mise/installs/uv/0.9.2"),
  },
  terraform: {
    foundry: at("1.13.4", "hercule", "~/.local/share/mise/installs/terraform/1.13.4"),
    atlas: at("1.13.4", "hercule", "~/.local/share/mise/installs/terraform/1.13.4"),
    "studio-mac": at("1.13.4", "hercule", "~/.local/share/mise/installs/terraform/1.13.4"),
    "hetzner-ax": at("1.13.4", "hercule", "~/.local/share/mise/installs/terraform/1.13.4"),
  },
};

const THREAD_TITLES: Readonly<Record<ProjectId, ReadonlyArray<readonly [string, string]>>> = {
  webshop: [
    ["fix-3ds-checkout", "Fix 3-D Secure checkout for EU cards"],
    ["promo-banner-cms", "Move the promo banner to the CMS"],
    ["vat-per-line", "Show VAT per line on invoices"],
    ["gallery-alt-text", "Add alt text to the gallery page"],
    ["cart-drawer-a11y", "Make the cart drawer keyboard friendly"],
    ["image-cdn", "Serve product images from the CDN"],
    ["search-typo", "Tolerate typos in product search"],
    ["wishlist-share", "Share a wishlist by link"],
    ["checkout-split", "Split checkout into three steps"],
    ["sitemap-locale", "Generate a sitemap per locale"],
    ["coupon-stacking", "Refuse stacked coupons"],
    ["vite-7", "Upgrade to Vite 7"],
    ["order-emails", "Redesign the order emails"],
    ["pdp-reviews", "Lazy-load reviews on product pages"],
    ["stock-badge", "Show low stock on the product card"],
    ["klarna", "Offer Klarna at checkout"],
    ["react-20", "Try React 20 in the storefront"],
    ["flaky-e2e", "Find the flaky checkout test"],
    ["dark-mode", "Dark mode for the storefront"],
    ["returns-portal", "Self-service returns portal"],
  ],
  "payments-api": [
    ["webhook-backoff", "Retry Stripe webhooks with backoff"],
    ["partial-refunds", "Refunds for partial captures"],
    ["payout-report", "Payout report for September"],
    ["idempotency-keys", "Idempotency keys on every POST"],
    ["ledger-audit", "Audit the ledger for rounding"],
    ["sepa-mandates", "Store SEPA mandates"],
    ["rate-limit", "Rate-limit the refund endpoint"],
    ["go-1-25", "Move to Go 1.25"],
    ["currency-fx", "Daily FX rates from the ECB"],
    ["dispute-flow", "Handle disputes end to end"],
  ],
  ops: [
    ["grafana-folders", "Migrate ops dashboards"],
    ["rotate-secrets", "Rotate staging secrets"],
    ["backup-check", "Check the nightly backups"],
    ["tf-modules", "Split the Terraform modules"],
    ["alert-noise", "Quiet the disk alerts"],
    ["k8s-1-34", "Upgrade the cluster to 1.34"],
  ],
};

/** A small deterministic random sequence, so the fixture is the same on every load. */
const makeRandom = (seed: number) => {
  let state = seed;
  return (): number => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
};

const PROJECT_SIZE: Readonly<Record<ProjectId, readonly [number, number]>> = {
  webshop: [1.8, 5.4],
  "payments-api": [0.6, 1.6],
  ops: [0.2, 0.9],
};

/**
 * Builds the workspaces of one machine: `inUse` in use, then idle clean ones,
 * then idle ones with changes, sized so the totals come near `idleGB`.
 */
const buildWorkspaces = (
  machineId: MachineId,
  seed: number,
  counts: { inUse: number; idleClean: number; idleDirty: number },
  totals: { inUseGB: number; idleCleanGB: number; idleDirtyGB: number },
): Workspace[] => {
  const random = makeRandom(seed);
  const projects: ProjectId[] = [
    "webshop",
    "webshop",
    "payments-api",
    "webshop",
    "ops",
    "payments-api",
  ];
  const build = (kind: "inUse" | "idleClean" | "idleDirty", index: number): Workspace => {
    const project = projects[Math.floor(random() * projects.length)]!;
    const titles = THREAD_TITLES[project];
    const [branch, thread] = titles[Math.floor(random() * titles.length)]!;
    const [low, high] = PROJECT_SIZE[project];
    const lastUsedDays =
      kind === "inUse"
        ? 0
        : kind === "idleClean"
          ? 15 + Math.floor(random() * 70)
          : 16 + Math.floor(random() * 40);
    return {
      id: `${machineId}-${kind}-${index}`,
      machineId,
      project,
      branch: `${branch}${random() > 0.7 ? `-${2 + Math.floor(random() * 3)}` : ""}`,
      thread,
      lastUsedDays,
      sizeGB: low + random() * (high - low),
      changes: kind === "idleDirty" ? 1 + Math.floor(random() * 9) : 0,
      inUse: kind === "inUse",
    };
  };
  const scale = (list: Workspace[], total: number): Workspace[] => {
    const sum = list.reduce((acc, each) => acc + each.sizeGB, 0);
    return list.map((each) => ({ ...each, sizeGB: (each.sizeGB / sum) * total }));
  };
  const range = (count: number) => Array.from({ length: count }, (_, index) => index);
  return [
    ...scale(
      range(counts.inUse).map((index) => build("inUse", index)),
      totals.inUseGB,
    ),
    ...scale(
      range(counts.idleClean).map((index) => build("idleClean", index)),
      totals.idleCleanGB,
    ),
    ...scale(
      range(counts.idleDirty).map((index) => build("idleDirty", index)),
      totals.idleDirtyGB,
    ),
  ];
};

const IDLE_WORKSPACES: ReadonlyArray<Workspace> = [
  ...buildWorkspaces(
    "atlas",
    11,
    { inUse: 0, idleClean: 9, idleDirty: 2 },
    { inUseGB: 0, idleCleanGB: 19, idleDirtyGB: 3 },
  ),
  ...buildWorkspaces(
    "beelink",
    23,
    { inUse: 0, idleClean: 54, idleDirty: 7 },
    { inUseGB: 0, idleCleanGB: 161, idleDirtyGB: 25 },
  ),
  ...buildWorkspaces(
    "studio-mac",
    37,
    { inUse: 0, idleClean: 11, idleDirty: 3 },
    { inUseGB: 0, idleCleanGB: 33, idleDirtyGB: 8 },
  ),
  ...buildWorkspaces(
    "hetzner-ax",
    41,
    { inUse: 0, idleClean: 4, idleDirty: 1 },
    { inUseGB: 0, idleCleanGB: 10, idleDirtyGB: 2 },
  ),
  ...buildWorkspaces(
    "foundry",
    61,
    { inUse: 0, idleClean: 38, idleDirty: 4 },
    { inUseGB: 0, idleCleanGB: 118, idleDirtyGB: 14 },
  ),
  ...buildWorkspaces(
    "office-mini",
    53,
    { inUse: 0, idleClean: 5, idleDirty: 2 },
    { inUseGB: 0, idleCleanGB: 12, idleDirtyGB: 4 },
  ),
];

// ---------- What runs where ----------

/** One session inside a workload. */
export interface WorkSession {
  readonly id: string;
  /** What the session is called in its workload: its role, or its title cut short. */
  readonly label: string;
  readonly kind: "thread" | "agent" | "run" | "assistant";
  /** `waiting` waits on the user; `queued` waits for a slot on this machine. */
  readonly state: "working" | "waiting" | "queued";
}

/**
 * The work in one workspace on one machine, as the user knows it: a
 * workflow's run, the threads of one sidebar row, or an assistant's
 * conversation. Its sessions are what count against the machine's cap.
 */
export interface Workload {
  readonly id: string;
  readonly machineId: MachineId;
  readonly kind: "threads" | "run" | "assistant";
  /** The run's workflow, the row's lead thread, or the assistant's name. */
  readonly title: string;
  readonly project: ProjectId | null;
  readonly branch: string | null;
  readonly sessions: ReadonlyArray<WorkSession>;
  readonly sizeGB: number;
  /** How long it has been at work, as words. */
  readonly since: string;
}

type Member = readonly [label: string, kind: WorkSession["kind"], state: WorkSession["state"]];

const buildThreads = (
  machineId: MachineId,
  id: string,
  title: string,
  project: ProjectId | null,
  branch: string,
  members: ReadonlyArray<Member>,
  sizeGB: number,
  since: string,
): Workload => ({
  id,
  machineId,
  kind: "threads",
  title,
  project,
  branch,
  sessions: members.map(([label, kind, state], index) => ({
    id: `${id}-${index}`,
    label,
    kind,
    state,
  })),
  sizeGB,
  since,
});

const buildRun = (
  machineId: MachineId,
  id: string,
  workflow: string,
  project: ProjectId,
  branch: string,
  steps: ReadonlyArray<readonly [label: string, state: WorkSession["state"]]>,
  sizeGB: number,
  since: string,
): Workload => ({
  id,
  machineId,
  kind: "run",
  title: workflow,
  project,
  branch,
  sessions: steps.map(([label, state], index) => ({
    id: `${id}-${index}`,
    label,
    kind: "run",
    state,
  })),
  sizeGB,
  since,
});

const FOUNDRY_RUNS: ReadonlyArray<readonly [string, ProjectId, number]> = [
  ["Review dependabot", "webshop", 3],
  ["Assign reviewers", "payments-api", 1],
  ["Label new issues", "webshop", 2],
  ["Check SSL expiry", "ops", 1],
  ["Bump dependencies", "webshop", 4],
  ["Watch flaky tests", "webshop", 2],
  ["Clean preview envs", "ops", 1],
  ["Translate docs", "webshop", 3],
  ["Audit IAM roles", "ops", 2],
];
const FOUNDRY_ROLES = ["review", "tests", "docs", "bisect", "lint"];

/** foundry's work: many runs and many rows of threads, 71 sessions in all. */
const buildFoundryWork = (): Workload[] => {
  const random = makeRandom(71);
  const runs = FOUNDRY_RUNS.map(([workflow, project, steps], index) =>
    buildRun(
      "foundry",
      `foundry-run-${index}`,
      workflow,
      project,
      `run/${workflow.toLowerCase().replaceAll(" ", "-")}-${120 + index}`,
      Array.from(
        { length: steps },
        (_, step) => [["triage", "fix", "review", "verify"][step % 4]!, "working"] as const,
      ),
      0.8 + random() * 3,
      `${4 + Math.floor(random() * 50)} min`,
    ),
  );
  // The rows elsewhere in the fixture keep their titles to themselves.
  const taken = new Set([
    "Serve product images from the CDN",
    "Move the promo banner to the CMS",
    "Quiet the disk alerts",
    "Find the flaky checkout test",
    "Fix 3-D Secure checkout for EU cards",
    "Payout report for September",
    "Migrate ops dashboards",
    "Rotate staging secrets",
    "Show VAT per line on invoices",
    "Refunds for partial captures",
    "Retry Stripe webhooks with backoff",
  ]);
  const titles = (["webshop", "payments-api", "ops"] as const)
    .flatMap((project) =>
      THREAD_TITLES[project].map(([branch, title]) => ({ project, branch, title })),
    )
    .filter((each) => !taken.has(each.title));
  const rows: Workload[] = [];
  let left = 71 - runs.reduce((sum, run) => sum + run.sessions.length, 0);
  for (let index = 0; left > 0; index += 1) {
    const { project, branch, title } = titles[index % titles.length]!;
    const size = Math.min(left, 1 + Math.floor(random() * 3));
    left -= size;
    rows.push(
      buildThreads(
        "foundry",
        `foundry-row-${index}`,
        title,
        project,
        branch,
        Array.from(
          { length: size },
          (_, member) =>
            [
              member === 0 ? "lead" : FOUNDRY_ROLES[(index + member) % FOUNDRY_ROLES.length]!,
              member === 0 ? "thread" : "agent",
              "working",
            ] as const,
        ),
        1 + random() * 4,
        `${1 + Math.floor(random() * 9)} h`,
      ),
    );
  }
  return [...runs, ...rows];
};

/**
 * What runs on each machine. The rows of threads and the runs on beelink and
 * studio-mac are the ones the sidebar's specimen shows, so the two agree.
 */
const WORKLOADS: ReadonlyArray<Workload> = [
  buildThreads(
    "atlas",
    "atlas-cdn",
    "Serve product images from the CDN",
    "webshop",
    "image-cdn",
    [["lead", "thread", "working"]],
    3.2,
    "40 min",
  ),
  {
    id: "atlas-ada",
    machineId: "atlas",
    kind: "assistant",
    title: "Ada",
    project: null,
    branch: null,
    sessions: [{ id: "atlas-ada-0", label: "Ada", kind: "assistant", state: "working" }],
    sizeGB: 0.2,
    since: "6 h",
  },
  buildRun(
    "beelink",
    "beelink-keys",
    "Rotate prod keys",
    "ops",
    "run/rotate-prod-keys-31",
    [
      ["rotate", "waiting"],
      ["verify", "working"],
    ],
    0.6,
    "1 h",
  ),
  buildRun(
    "beelink",
    "beelink-backup",
    "Nightly backup check",
    "ops",
    "run/nightly-backup-check-88",
    [["compare", "working"]],
    0.4,
    "12 min",
  ),
  buildThreads(
    "beelink",
    "beelink-promo",
    "Move the promo banner to the CMS",
    "webshop",
    "promo-banner-cms",
    [
      ["lead", "thread", "working"],
      ["review", "agent", "working"],
    ],
    6.1,
    "2 h",
  ),
  buildThreads(
    "beelink",
    "beelink-alerts",
    "Quiet the disk alerts",
    "ops",
    "alert-noise",
    [["lead", "thread", "working"]],
    0.9,
    "25 min",
  ),
  buildThreads(
    "beelink",
    "beelink-flaky",
    "Find the flaky checkout test",
    "webshop",
    "flaky-e2e",
    [
      ["lead", "thread", "working"],
      ["bisect", "agent", "working"],
      ["bisect 2", "agent", "working"],
    ],
    9.4,
    "3 h",
  ),
  buildThreads(
    "studio-mac",
    "studio-3ds",
    "Fix 3-D Secure checkout for EU cards",
    "webshop",
    "fix-3ds-checkout",
    [
      ["lead", "thread", "waiting"],
      ["tests", "agent", "working"],
    ],
    7.2,
    "4 h",
  ),
  buildThreads(
    "studio-mac",
    "studio-payout",
    "Payout report for September",
    "payments-api",
    "payout-report",
    [["lead", "thread", "working"]],
    1.4,
    "1 h",
  ),
  buildThreads(
    "studio-mac",
    "studio-grafana",
    "Migrate ops dashboards",
    "ops",
    "grafana-folders",
    [["lead", "thread", "waiting"]],
    0.7,
    "2 h",
  ),
  buildRun(
    "studio-mac",
    "studio-release",
    "Ship release",
    "webshop",
    "release/2.14.0",
    [
      ["security", "waiting"],
      ["review", "working"],
      ["changelog", "working"],
    ],
    6.8,
    "29 min",
  ),
  buildThreads(
    "studio-mac",
    "studio-secrets",
    "Rotate staging secrets",
    "ops",
    "rotate-secrets",
    [["lead", "thread", "working"]],
    0.6,
    "50 min",
  ),
  buildThreads(
    "studio-mac",
    "studio-vat",
    "Show VAT per line on invoices",
    "webshop",
    "vat-per-line",
    [["lead", "thread", "queued"]],
    4.1,
    "6 min",
  ),
  buildThreads(
    "studio-mac",
    "studio-refunds",
    "Refunds for partial captures",
    "payments-api",
    "partial-refunds",
    [["lead", "thread", "queued"]],
    1.3,
    "4 min",
  ),
  buildThreads(
    "studio-mac",
    "studio-webhooks",
    "Retry Stripe webhooks with backoff",
    "payments-api",
    "webhook-backoff",
    [["lead", "thread", "queued"]],
    1.1,
    "1 min",
  ),
  buildRun(
    "hetzner-ax",
    "hetzner-fix",
    "Fix bug",
    "webshop",
    "run/fix-bug-1298",
    [["fix", "working"]],
    3.3,
    "18 min",
  ),
  buildRun(
    "hetzner-ax",
    "hetzner-investigate",
    "Investigate",
    "payments-api",
    "run/investigate-1294",
    [["investigate", "working"]],
    1.2,
    "9 min",
  ),
  buildRun(
    "hetzner-ax",
    "hetzner-translate",
    "Translate docs",
    "webshop",
    "run/translate-docs-77",
    [["translate", "working"]],
    2.6,
    "11 min",
  ),
  ...buildFoundryWork(),
];

/** The workspaces the workloads work in, all in use. */
const WORKSPACES: ReadonlyArray<Workspace> = [
  ...IDLE_WORKSPACES,
  ...WORKLOADS.map((workload) => ({
    id: `ws-${workload.id}`,
    machineId: workload.machineId,
    project: workload.project ?? "webshop",
    branch: workload.branch ?? "",
    thread: workload.title,
    lastUsedDays: 0,
    sizeGB: workload.sizeGB,
    changes: 0,
    inUse: true,
  })),
];

/** The machines, with their running and waiting sessions counted from the workloads. */
const LOADED_MACHINES: ReadonlyArray<Machine> = MACHINES.map((machine) => {
  const sessions = WORKLOADS.filter((each) => each.machineId === machine.id).flatMap(
    (each) => each.sessions,
  );
  return machine.connectivity !== "online"
    ? machine
    : {
        ...machine,
        running: sessions.filter((each) => each.state !== "queued").length,
        queued: sessions.filter((each) => each.state === "queued").length,
      };
});

/** How long an idle workspace waits before the page offers to remove it. */
export const IDLE_DAYS = 14;

// ---------- The store ----------

/** Every tool follows its newest version: round 3 dropped pins and hands off. */
const POLICIES: FleetState["policies"] = Object.fromEntries(
  [
    "claude-code",
    "codex",
    "pi",
    "runner",
    "git",
    "gh",
    "node",
    "pnpm",
    "go",
    "docker",
    "python",
    "uv",
    "terraform",
  ].map((id) => [id, "newest" as const]),
);

/** The days of the last two weeks, as the activity list heads them. The specimen's clock stands at Tue 29 Sep, 09:41. */
const DAYS = [
  "Today",
  "Yesterday",
  "Sun 27 Sep",
  "Sat 26 Sep",
  "Fri 25 Sep",
  "Thu 24 Sep",
  "Wed 23 Sep",
  "Tue 22 Sep",
  "Mon 21 Sep",
  "Sun 20 Sep",
];

type Scripted = Omit<ActivityEntry, "id">;

/** What happened on each machine besides its sessions, newest first. */
const SCRIPTED: Readonly<Record<MachineId, ReadonlyArray<Scripted>>> = {
  atlas: [
    {
      day: "Today",
      time: "08:02",
      category: "connection",
      problem: false,
      text: "Back online",
      actor: "Hercule",
      source: "runner.stateChanged",
    },
    {
      day: "Yesterday",
      time: "18:40",
      category: "connection",
      problem: false,
      text: "Signed off: the Mac went to sleep",
      actor: "Hercule",
      source: "runner.stateChanged",
    },
    {
      day: "Yesterday",
      time: "08:05",
      category: "connection",
      problem: false,
      text: "Back online",
      actor: "Hercule",
      source: "runner.stateChanged",
    },
    {
      day: "Sun 27 Sep",
      time: "16:12",
      category: "settings",
      problem: false,
      text: "Logged in to Claude",
      actor: "you",
      source: "provider.loggedIn",
    },
    {
      day: "Fri 25 Sep",
      time: "18:40",
      category: "workspaces",
      problem: false,
      text: "Removed 6 workspaces",
      actor: "you",
      source: "workspace.deleted",
      items: [
        "Upgrade to Vite 7",
        "Share a wishlist by link",
        "Dark mode for the storefront",
        "Split checkout into three steps",
        "Redesign the order emails",
        "Try React 20 in the storefront",
      ],
    },
  ],
  beelink: [
    {
      day: "Yesterday",
      time: "21:30",
      category: "settings",
      problem: false,
      text: "Session cap changed from 10 to 13",
      actor: "you",
      source: "runner.updated",
    },
    {
      day: "Sun 27 Sep",
      time: "11:09",
      category: "connection",
      problem: false,
      text: "Back online after 4 minutes",
      actor: "Hercule",
      source: "runner.stateChanged",
    },
    {
      day: "Sun 27 Sep",
      time: "11:05",
      category: "connection",
      problem: true,
      text: "Stopped answering, without signing off",
      actor: "Hercule",
      source: "runner.stateChanged",
    },
    {
      day: "Sun 27 Sep",
      time: "11:05",
      category: "sessions",
      problem: true,
      text: "2 sessions ended when contact was lost",
      actor: "Hercule",
      source: "session.reconciled",
      items: ["Quiet the disk alerts", "Nightly backup check · compare"],
    },
    {
      day: "Thu 24 Sep",
      time: "15:44",
      category: "workspaces",
      problem: true,
      text: "Could not remove a workspace: it has uncommitted changes",
      actor: "you",
      source: "workspace.disposalRefused",
      items: ["Fix 3-D Secure checkout for EU cards"],
    },
    {
      day: "Wed 23 Sep",
      time: "10:20",
      category: "sessions",
      problem: true,
      text: "1 session ended when the runner restarted",
      actor: "Hercule",
      source: "session.reconciled",
      items: ["Move to Go 1.25"],
    },
  ],
  "studio-mac": [
    {
      day: "Sat 26 Sep",
      time: "10:00",
      category: "connection",
      problem: false,
      text: "Joined the fleet",
      actor: "Hercule",
      source: "runner.joined",
    },
    {
      day: "Sat 26 Sep",
      time: "10:02",
      category: "settings",
      problem: false,
      text: "Labels changed to mac, gpu",
      actor: "you",
      source: "runner.updated",
    },
  ],
  "hetzner-ax": [
    {
      day: "Fri 25 Sep",
      time: "16:22",
      category: "settings",
      problem: false,
      text: "Session cap changed from 8 to 12",
      actor: "you",
      source: "runner.updated",
    },
    {
      day: "Thu 24 Sep",
      time: "08:00",
      category: "connection",
      problem: false,
      text: "Joined the fleet",
      actor: "Hercule",
      source: "runner.joined",
    },
  ],
  foundry: [
    {
      day: "Mon 21 Sep",
      time: "10:12",
      category: "connection",
      problem: false,
      text: "Joined the fleet",
      actor: "Hercule",
      source: "runner.joined",
    },
    {
      day: "Mon 21 Sep",
      time: "10:15",
      category: "settings",
      problem: false,
      text: "Session cap changed from 64 to 96",
      actor: "you",
      source: "runner.updated",
    },
  ],
  "office-mini": [
    {
      day: "Yesterday",
      time: "14:02",
      category: "connection",
      problem: true,
      text: "Stopped answering, without signing off",
      actor: "Hercule",
      source: "runner.stateChanged",
    },
    {
      day: "Sat 26 Sep",
      time: "09:00",
      category: "connection",
      problem: false,
      text: "Back online",
      actor: "Hercule",
      source: "runner.stateChanged",
    },
    {
      day: "Fri 25 Sep",
      time: "19:12",
      category: "connection",
      problem: false,
      text: "Signed off",
      actor: "Hercule",
      source: "runner.stateChanged",
    },
  ],
};

const RUN_NAMES = [
  "Fix bug",
  "Investigate",
  "Review dependabot",
  "Translate docs",
  "Label new issues",
  "Nightly backup check",
];

/**
 * Builds a machine's activity: its scripted entries, the sessions its
 * current work started today, and on earlier days the sessions started and
 * the workspaces Hercule removed after their runs finished. Sessions started
 * together for one piece of work are one entry, with each session listed.
 */
const buildActivity = (machine: Machine, index: number): ActivityEntry[] => {
  const random = makeRandom(500 + index * 7);
  const entries: Scripted[] = [...SCRIPTED[machine.id]];
  const work = WORKLOADS.filter((each) => each.machineId === machine.id);
  work.forEach((workload, order) => {
    const minutes = 9 * 60 + 38 - order * 23 - Math.floor(random() * 10);
    const time = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    const started = workload.sessions.filter((each) => each.state !== "queued");
    if (started.length === 0) return;
    entries.push({
      day: "Today",
      time,
      category: "sessions",
      problem: false,
      text: `${started.length === 1 ? "Started a session" : `Started ${started.length} sessions`} for ${workload.title}`,
      actor: workload.kind === "run" ? "Hercule" : "you",
      source: "session.spawned",
      items: started.map((each) => each.label),
    });
  });
  if (machine.connectivity === "online" || machine.lostContact) {
    for (let day = 1; day < DAYS.length; day += 1) {
      if (machine.id === "office-mini" && day < 2) continue;
      const busy = machine.id === "foundry" ? 9 : machine.id === "atlas" ? 2 : 4;
      const count = 1 + Math.floor(random() * busy);
      for (let each = 0; each < count; each += 1) {
        const hour = 8 + Math.floor(random() * 11);
        const titles =
          THREAD_TITLES[(["webshop", "payments-api", "ops"] as const)[Math.floor(random() * 3)]!];
        const isRun = random() > 0.6;
        const title = isRun
          ? RUN_NAMES[Math.floor(random() * RUN_NAMES.length)]!
          : titles[Math.floor(random() * titles.length)]![1];
        const sessions = 1 + Math.floor(random() * 3);
        entries.push({
          day: DAYS[day]!,
          time: `${String(hour).padStart(2, "0")}:${String(Math.floor(random() * 60)).padStart(2, "0")}`,
          category: "sessions",
          problem: false,
          text: `${sessions === 1 ? "Started a session" : `Started ${sessions} sessions`} for ${title}`,
          actor: isRun ? "Hercule" : "you",
          source: "session.spawned",
          items: Array.from({ length: sessions }, (_, member) =>
            member === 0 ? (isRun ? "triage" : "lead") : ["review", "tests", "fix"][member - 1]!,
          ),
        });
      }
      if (machine.kind === "server" && random() > 0.35) {
        const removed = 1 + Math.floor(random() * (machine.id === "foundry" ? 12 : 4));
        entries.push({
          day: DAYS[day]!,
          time: "03:10",
          category: "workspaces",
          problem: false,
          text: `Removed ${removed} ${removed === 1 ? "workspace" : "workspaces"} of finished runs`,
          actor: "Hercule",
          source: "workspace.deleted",
          items: Array.from(
            { length: removed },
            (_, item) => `${RUN_NAMES[item % RUN_NAMES.length]} · run completed`,
          ),
        });
      }
    }
  }
  return entries
    .toSorted((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || b.time.localeCompare(a.time))
    .map((entry, order) => ({ ...entry, id: `${machine.id}-${order}` }));
};

const ACTIVITY: FleetState["activity"] = Object.fromEntries(
  MACHINES.map((machine, index) => [machine.id, buildActivity(machine, index)]),
) as unknown as FleetState["activity"];

let state: FleetState = {
  machines: LOADED_MACHINES,
  workloads: WORKLOADS,
  workspaces: WORKSPACES,
  installed: INSTALLED,
  pending: new Set(),
  toast: null,
  policies: POLICIES,
  autoClean: "off",
  activity: ACTIVITY,
};
const listeners = new Set<() => void>();
let toastId = 0;

const setState = (next: FleetState): void => {
  state = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Returns the fleet's state, and draws the component again whenever it changes. */
export const useFleet = (): FleetState => useSyncExternalStore(subscribe, () => state);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const startPending = (keys: ReadonlyArray<string>): void => {
  const pending = new Set(state.pending);
  for (const key of keys) pending.add(key);
  setState({ ...state, pending });
};
const endPending = (
  keys: ReadonlyArray<string>,
  changes: Partial<FleetState>,
  toast: string,
): void => {
  const pending = new Set(state.pending);
  for (const key of keys) pending.delete(key);
  toastId += 1;
  setState({ ...state, ...changes, pending, toast: { id: toastId, text: toast } });
};

export const toolKey = (toolId: string, machineId: MachineId): string =>
  `tool:${toolId}:${machineId}`;

/** Installs or updates `toolId` to its target on each of `machineIds`. */
export async function installTool(
  toolId: string,
  machineIds: ReadonlyArray<MachineId>,
): Promise<void> {
  const tool = TOOL_BY_ID.get(toolId)!;
  const keys = machineIds.map((machineId) => toolKey(toolId, machineId));
  startPending(keys);
  await wait(1400 + machineIds.length * 350);
  const perMachine = { ...state.installed[toolId] };
  for (const machineId of machineIds) {
    const machine = state.machines.find((each) => each.id === machineId)!;
    perMachine[machineId] = {
      version: tool.target,
      source: "hercule",
      path:
        tool.kind === "runner"
          ? "~/.hercule/bin/hercule"
          : `~/.local/share/mise/installs/${tool.id}/${tool.target}`,
    };
    void machine;
  }
  const machines =
    tool.kind === "runner"
      ? state.machines.map((each) =>
          machineIds.includes(each.id) ? { ...each, runnerVersion: tool.target } : each,
        )
      : state.machines;
  const where = machineIds.length === 1 ? machineIds[0] : `${machineIds.length} machines`;
  endPending(
    keys,
    { installed: { ...state.installed, [toolId]: perMachine }, machines },
    `${tool.name} ${tool.target} is on ${where}`,
  );
}

/** Removes the workspaces `workspaceIds` from `machineId`, and frees their space. */
export async function removeWorkspaces(
  machineId: MachineId,
  workspaceIds: ReadonlySet<string>,
): Promise<void> {
  const key = `cleanup:${machineId}`;
  startPending([key]);
  await wait(1800);
  const removed = state.workspaces.filter((each) => workspaceIds.has(each.id));
  const freed = removed.reduce((sum, each) => sum + each.sizeGB, 0);
  endPending(
    [key],
    {
      workspaces: state.workspaces.filter((each) => !workspaceIds.has(each.id)),
      machines: state.machines.map((each) =>
        each.id === machineId
          ? {
              ...each,
              diskFreeGB: each.diskFreeGB + freed,
              diskTrendGBPerDay: Math.max(each.diskTrendGBPerDay, -1.4),
            }
          : each,
      ),
    },
    `Removed ${removed.length} workspaces from ${machineId}. ${formatGB(freed)} freed`,
  );
  logActivity([machineId], {
    category: "workspaces",
    problem: false,
    text: `Removed ${removed.length} workspaces`,
    actor: "you",
    source: "workspace.deleted",
    items: removed.map((each) => each.thread),
  });
}

/** Returns `workloads` with the first `count` sessions waiting for a slot on `machineId` started. */
const startQueued = (
  workloads: ReadonlyArray<Workload>,
  machineId: MachineId,
  count: number,
): ReadonlyArray<Workload> => {
  let left = count;
  return workloads.map((workload) => {
    if (workload.machineId !== machineId || left === 0) return workload;
    return {
      ...workload,
      since: workload.sessions.some((each) => each.state === "queued")
        ? "just now"
        : workload.since,
      sessions: workload.sessions.map((session) => {
        if (session.state !== "queued" || left === 0) return session;
        left -= 1;
        return { ...session, state: "working" as const };
      }),
    };
  });
};

/** Sets how many sessions `machineId` runs at once. */
export async function setSlots(machineId: MachineId, slots: number): Promise<void> {
  const key = `slots:${machineId}`;
  startPending([key]);
  await wait(700);
  const machine = state.machines.find((each) => each.id === machineId)!;
  const started = Math.min(machine.queued, Math.max(0, slots - machine.running));
  endPending(
    [key],
    {
      machines: state.machines.map((each) =>
        each.id === machineId
          ? { ...each, slots, running: each.running + started, queued: each.queued - started }
          : each,
      ),
      workloads: startQueued(state.workloads, machineId, started),
    },
    started > 0
      ? `${machineId} runs up to ${slots} sessions. ${started} waiting ${started === 1 ? "thread" : "threads"} started`
      : `${machineId} runs up to ${slots} sessions`,
  );
  logActivity([machineId], {
    category: "settings",
    problem: false,
    text: `Session cap changed from ${machine.slots} to ${slots}`,
    actor: "you",
    source: "runner.updated",
  });
}

/** Stops new work on `machineId`, or lets it take new work again. */
export function setDraining(machineId: MachineId, draining: boolean): void {
  toastId += 1;
  setState({
    ...state,
    machines: state.machines.map((each) =>
      each.id === machineId ? { ...each, lifecycle: draining ? "draining" : "active" } : each,
    ),
    toast: {
      id: toastId,
      text: draining
        ? `${machineId} takes no new sessions. Running ones finish`
        : `${machineId} takes new sessions again`,
    },
  });
  logActivity([machineId], {
    category: "settings",
    problem: false,
    text: draining ? "Stopped taking new work" : "Took new work again",
    actor: "you",
    source: draining ? "runner.drained" : "runner.undrained",
  });
}

export function dismissToast(): void {
  setState({ ...state, toast: null });
}

// ---------- What the page works out from the state ----------

export const formatGB = (gb: number): string => {
  if (gb >= 1000) return `${(gb / 1000).toFixed(gb >= 10000 ? 0 : 1)} TB`;
  if (gb >= 10) return `${Math.round(gb)} GB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(gb * 1000)} MB`;
};

export const formatDays = (days: number): string => {
  if (days === 0) return "Now";
  if (days === 1) return "Yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
};

/** Compares two dotted versions: negative when `a` is older than `b`. */
export const compareVersions = (a: string, b: string): number => {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

/** Checks that `version` is in `range`, which names a major or a major.minor. */
export const satisfies = (version: string, range: string): boolean =>
  version === range || version.startsWith(`${range}.`);

export interface DiskParts {
  readonly inUse: number;
  readonly idle: number;
  readonly idleClean: number;
  readonly idleDirty: number;
  readonly caches: number;
  readonly providerData: number;
  readonly logs: number;
  readonly other: number;
  readonly used: number;
  readonly free: number;
}

/** Splits a machine's disk into what holds it. */
export const buildDiskParts = (
  machine: Machine,
  workspaces: ReadonlyArray<Workspace>,
): DiskParts => {
  const own = workspaces.filter((each) => each.machineId === machine.id);
  const sum = (list: ReadonlyArray<Workspace>) => list.reduce((acc, each) => acc + each.sizeGB, 0);
  const inUse = sum(own.filter((each) => each.inUse || each.lastUsedDays < IDLE_DAYS));
  const idleClean = sum(
    own.filter((each) => !each.inUse && each.lastUsedDays >= IDLE_DAYS && each.changes === 0),
  );
  const idleDirty = sum(
    own.filter((each) => !each.inUse && each.lastUsedDays >= IDLE_DAYS && each.changes > 0),
  );
  const used = machine.diskTotalGB - machine.diskFreeGB;
  const hercule =
    inUse + idleClean + idleDirty + machine.caches + machine.providerData + machine.logs;
  return {
    inUse,
    idle: idleClean + idleDirty,
    idleClean,
    idleDirty,
    caches: machine.caches,
    providerData: machine.providerData,
    logs: machine.logs,
    other: Math.max(0, used - hercule),
    used,
    free: machine.diskFreeGB,
  };
};

export const idleWorkspaces = (
  machineId: MachineId,
  workspaces: ReadonlyArray<Workspace>,
): Workspace[] =>
  workspaces.filter(
    (each) => each.machineId === machineId && !each.inUse && each.lastUsedDays >= IDLE_DAYS,
  );

/** The share of the disk in use, from 0 to 1. */
export const diskShare = (machine: Machine): number => 1 - machine.diskFreeGB / machine.diskTotalGB;
export const memoryShare = (machine: Machine): number =>
  1 - machine.memoryFreeGB / machine.memoryTotalGB;

/** Days until the free space reaches the watermark at the current trend, or null when it is not shrinking fast. */
export const daysUntilFull = (machine: Machine): number | null => {
  if (machine.diskTrendGBPerDay > -1) return null;
  const days = Math.max(
    0,
    Math.round((machine.diskFreeGB - machine.diskWatermarkGB) / -machine.diskTrendGBPerDay),
  );
  // Further out than two months, a forecast is noise.
  return days > 60 ? null : days;
};

export type Level = "ok" | "warn" | "crit";

export const diskLevel = (machine: Machine): Level => {
  if (machine.diskFreeGB <= machine.diskWatermarkGB) return "crit";
  const days = daysUntilFull(machine);
  if (diskShare(machine) >= 0.85 || (days !== null && days < 21)) return "warn";
  return "ok";
};
export const memoryLevel = (machine: Machine): Level =>
  machine.connectivity === "offline"
    ? "ok"
    : memoryShare(machine) >= 0.92
      ? "crit"
      : memoryShare(machine) >= 0.8
        ? "warn"
        : "ok";
export const slotsLevel = (machine: Machine): Level => (machine.queued > 0 ? "warn" : "ok");

export type ToolStatus =
  | { readonly kind: "current"; readonly installed: Installed }
  | { readonly kind: "older"; readonly installed: Installed }
  | { readonly kind: "missing" }
  | { readonly kind: "unknown"; readonly installed: Installed | undefined };

/** Where `tool` stands on `machine` against its target. */
/**
 * Returns the newest version of `tool`: for a harness or the runner, the
 * newest this Hercule release supports; for a toolchain, the newest found on
 * any online machine, so no outside source is needed.
 */
export const findNewest = (fleet: FleetState, tool: Tool): string => {
  if (tool.kind !== "toolchain") return tool.target;
  const found = fleet.machines
    .filter((machine) => machine.connectivity === "online")
    .map((machine) => fleet.installed[tool.id]?.[machine.id]?.version)
    .filter((version): version is string => version !== undefined);
  return found.reduce(
    (newest, each) => (compareVersions(each, newest) > 0 ? each : newest),
    found[0] ?? tool.target,
  );
};

export const readToolStatus = (fleet: FleetState, tool: Tool, machine: Machine): ToolStatus => {
  const installed = fleet.installed[tool.id]?.[machine.id];
  if (machine.connectivity === "offline") return { kind: "unknown", installed };
  if (installed === undefined) return { kind: "missing" };
  // A pinned tool is behind on any other version; a newest one only when older.
  const behind =
    fleet.policies[tool.id] === "pinned"
      ? installed.version !== tool.target
      : compareVersions(installed.version, findNewest(fleet, tool)) < 0;
  return behind ? { kind: "older", installed } : { kind: "current", installed };
};

export interface Gap {
  readonly tool: Tool;
  readonly need: Need;
  /** The version on the machine, or null when the tool is not there. */
  readonly has: string | null;
}

/** What `project` needs that `machine` does not have. */
export const findGaps = (fleet: FleetState, project: ProjectId, machine: Machine): Gap[] => {
  const gaps: Gap[] = [];
  for (const tool of TOOLS) {
    for (const need of tool.needs) {
      if (need.project !== project) continue;
      const installed = fleet.installed[tool.id]?.[machine.id];
      if (installed === undefined || !satisfies(installed.version, need.range)) {
        gaps.push({ tool, need, has: installed?.version ?? null });
      }
    }
  }
  return gaps;
};

/** Checks whether Hercule can install `tool` on `machine` itself. */
export const canInstall = (tool: Tool, machine: Machine): boolean =>
  tool.via[machine.platform] !== null;

/** The machines where `tool` is older than its target, or missing where a project needs it. */
export const machinesToUpdate = (fleet: FleetState, tool: Tool): Machine[] =>
  fleet.machines.filter((machine) => readToolStatus(fleet, tool, machine).kind === "older");

export interface Issue {
  readonly machineId: MachineId;
  readonly level: "crit" | "warn";
  readonly kind: "offline" | "disk" | "slots" | "memory";
}

/** The problems on the fleet that need the user, worst first. */
export const findIssues = (fleet: FleetState): Issue[] => {
  const issues: Issue[] = [];
  for (const machine of fleet.machines) {
    if (machine.connectivity === "offline") {
      issues.push({ machineId: machine.id, level: "crit", kind: "offline" });
      continue;
    }
    const disk = diskLevel(machine);
    if (disk !== "ok") issues.push({ machineId: machine.id, level: disk, kind: "disk" });
    if (slotsLevel(machine) === "warn")
      issues.push({ machineId: machine.id, level: "warn", kind: "slots" });
    const memory = memoryLevel(machine);
    if (memory !== "ok") issues.push({ machineId: machine.id, level: memory, kind: "memory" });
  }
  return issues.sort((a, b) => (a.level === b.level ? 0 : a.level === "crit" ? -1 : 1));
};

/**
 * The session cap that lets every waiting thread start, kept to what the free
 * memory allows at about 6 GB a session.
 */
export const suggestSlots = (machine: Machine): number =>
  Math.min(machine.slots + machine.queued, machine.slots + Math.floor(machine.memoryFreeGB / 6));

export const machineById = (fleet: FleetState, id: MachineId): Machine =>
  fleet.machines.find((each) => each.id === id)!;

// ---------- Round 2: history, headroom, the baseline, activity ----------

/** Adds an entry, dated now, to the activity of each of `machineIds`. */
let activityId = 0;
const logActivity = (
  machineIds: ReadonlyArray<MachineId>,
  entry: Omit<ActivityEntry, "id" | "day" | "time">,
): void => {
  const activity = { ...state.activity };
  for (const id of machineIds) {
    activityId += 1;
    activity[id] = [
      { ...entry, id: `new-${activityId}`, day: "Today", time: "09:41" },
      ...activity[id],
    ];
  }
  setState({ ...state, activity });
};

export interface History {
  /** NEW: free disk space at the end of each of the last 14 days, oldest first. */
  readonly diskFree: ReadonlyArray<number>;
  /** NEW: sessions running in each half hour of the last 24 hours, oldest first. */
  readonly sessions: ReadonlyArray<number>;
  /** NEW: threads waiting for a slot in each half hour. */
  readonly waiting: ReadonlyArray<number>;
  /** NEW: the share of memory in use in each half hour. */
  readonly memory: ReadonlyArray<number>;
}

/** How busy a machine is through the day, from 0 to 1, by hour. */
const DAY_SHAPE = [
  0.15, 0.1, 0.1, 0.1, 0.1, 0.12, 0.2, 0.35, 0.6, 0.85, 0.95, 1, 0.9, 0.85, 0.95, 1, 0.95, 0.85,
  0.7, 0.55, 0.45, 0.35, 0.25, 0.2,
];
/** The hour of the last half hour drawn: the specimen's clock stands at 09:41. */
const NOW_HOUR = 9.5;

const HISTORIES: ReadonlyMap<
  MachineId,
  Omit<History, "diskFree"> & { readonly diskPast: ReadonlyArray<number> }
> = new Map(
  LOADED_MACHINES.map((machine, index) => {
    const random = makeRandom(97 + index * 13);
    const demand =
      machine.id === "foundry"
        ? 84
        : machine.id === "studio-mac"
          ? 11
          : machine.id === "beelink"
            ? 11
            : machine.id === "atlas"
              ? 3
              : 4;
    const sessions: number[] = [];
    const waiting: number[] = [];
    const memory: number[] = [];
    for (let step = 47; step >= 0; step -= 1) {
      const hour = (((NOW_HOUR - step / 2) % 24) + 24) % 24;
      const wanted =
        machine.connectivity === "online"
          ? Math.round(DAY_SHAPE[Math.floor(hour)]! * demand * (0.94 + random() * 0.12))
          : 0;
      const runningThen = Math.min(machine.slots, wanted);
      sessions.push(runningThen);
      waiting.push(Math.max(0, wanted - machine.slots));
      memory.push(Math.min(0.97, 0.22 + (runningThen / machine.slots) * 0.62 + random() * 0.04));
    }
    if (machine.connectivity === "online") {
      sessions[47] = machine.running;
      waiting[47] = machine.queued;
      memory[47] = 1 - machine.memoryFreeGB / machine.memoryTotalGB;
    }
    const diskPast = Array.from({ length: 14 }, (_, day) => {
      const daysAgo = 14 - day;
      return (
        machine.diskFreeGB -
        machine.diskTrendGBPerDay * daysAgo +
        (random() - 0.5) * machine.diskTotalGB * 0.006
      );
    });
    return [machine.id, { sessions, waiting, memory, diskPast }];
  }),
);

/** The history of `machine`, its last points being now. */
export const readHistory = (machine: Machine): History => {
  const history = HISTORIES.get(machine.id)!;
  return { ...history, diskFree: [...history.diskPast, machine.diskFreeGB] };
};

/** NEW: what a session takes on average, measured over the fleet's last month. */
export const MEMORY_PER_SESSION_GB = 2.5;
export const DISK_PER_WORKSPACE_GB = 3;

export interface Headroom {
  /** Free slots under the session cap. */
  readonly slots: number;
  /** Sessions the free memory would hold. */
  readonly memory: number;
  /** Workspaces the disk would hold before its limit. */
  readonly disk: number;
  /** How many more sessions the machine can start now: the smallest of the three. */
  readonly room: number;
  readonly limit: "slots" | "memory" | "disk";
}

/** Works out how many more sessions `machine` can take, and what stops it taking more. */
export const computeHeadroom = (machine: Machine): Headroom => {
  const slots = Math.max(0, machine.slots - machine.running);
  const memory = Math.floor(machine.memoryFreeGB / MEMORY_PER_SESSION_GB);
  const disk = Math.max(
    0,
    Math.floor((machine.diskFreeGB - machine.diskWatermarkGB) / DISK_PER_WORKSPACE_GB),
  );
  const room = Math.min(slots, memory, disk);
  const limit = room === slots ? "slots" : room === memory ? "memory" : "disk";
  return { slots, memory, disk, room, limit };
};

/** Words for what limits a machine, as a sentence ends. */
export const describeLimit = (headroom: Headroom): string =>
  headroom.limit === "slots"
    ? "its session cap is the limit"
    : headroom.limit === "memory"
      ? "memory runs out before its slots do"
      : "its disk runs out first";

export interface ToolNews {
  /** NEW: the vendor's newest version, which can be newer than what this Hercule supports. */
  readonly vendorLatest: string;
  readonly notes: ReadonlyArray<string>;
  readonly released: string;
}

export const TOOL_NEWS: Readonly<Record<string, ToolNews>> = {
  "claude-code": {
    vendorLatest: "2.6.17",
    released: "3 days ago",
    notes: [
      "Subagents stream their progress into the parent's transcript.",
      "Faster startup in large repositories.",
      "Fixes a hang when a tool prints more than 1 MB.",
    ],
  },
  codex: {
    vendorLatest: "0.95.1",
    released: "6 days ago",
    notes: ["Resumes a session after a lost connection.", "Smaller memory use with long contexts."],
  },
  pi: {
    vendorLatest: "0.52.3",
    released: "2 weeks ago",
    notes: ["Reads keys from the environment it is started in."],
  },
  runner: {
    vendorLatest: CONTROLLER_VERSION,
    released: "Yesterday",
    notes: ["Reports disk use per workspace.", "Restarts by itself after an update."],
  },
};

export interface Change {
  readonly tool: Tool;
  readonly machine: Machine;
  readonly from: string | null;
  readonly kind: "update" | "install" | "alongside";
  /** Why the change is needed, for the review. */
  readonly why: string;
}

/**
 * Lists every update the online machines need: each installed tool that is
 * behind the version Hercule keeps it at. A missing tool is not an update;
 * installing one is the user's choice. Tools left hands off, or that Hercule
 * cannot install, are left out.
 */
export const buildChanges = (fleet: FleetState): Change[] => {
  const changes: Change[] = [];
  for (const machine of fleet.machines) {
    if (machine.connectivity !== "online") continue;
    for (const tool of TOOLS) {
      const policy = fleet.policies[tool.id];
      if (policy === "hands-off" || !canInstall(tool, machine)) continue;
      const status = readToolStatus(fleet, tool, machine);
      if (status.kind !== "older") continue;
      changes.push({
        tool,
        machine,
        from: status.installed.version,
        kind: status.installed.source === "machine" ? "alongside" : "update",
        why:
          tool.kind === "toolchain"
            ? "the newest on another machine"
            : "the newest this Hercule supports",
      });
    }
  }
  return changes;
};

/** Applies `changes`, one machine's changes after another on each machine, all machines at once. */
export async function applyChanges(changes: ReadonlyArray<Change>): Promise<void> {
  startPending(changes.map((change) => toolKey(change.tool.id, change.machine.id)));
  const byMachine = new Map<MachineId, Change[]>();
  for (const change of changes) {
    byMachine.set(change.machine.id, [...(byMachine.get(change.machine.id) ?? []), change]);
  }
  await Promise.all(
    [...byMachine.values()].map(async (list) => {
      for (const change of list) {
        await wait(650 + Math.random() * 500);
        const key = toolKey(change.tool.id, change.machine.id);
        const pending = new Set(state.pending);
        pending.delete(key);
        const perMachine = { ...state.installed[change.tool.id] };
        perMachine[change.machine.id] = {
          version: change.tool.target,
          source: "hercule",
          path:
            change.tool.kind === "runner"
              ? "~/.hercule/bin/hercule"
              : `~/.local/share/mise/installs/${change.tool.id}/${change.tool.target}`,
        };
        setState({
          ...state,
          pending,
          installed: { ...state.installed, [change.tool.id]: perMachine },
          machines:
            change.tool.kind === "runner"
              ? state.machines.map((each) =>
                  each.id === change.machine.id
                    ? { ...each, runnerVersion: change.tool.target }
                    : each,
                )
              : state.machines,
        });
      }
    }),
  );
  toastId += 1;
  setState({
    ...state,
    toast: { id: toastId, text: `${changes.length} changes applied on ${byMachine.size} machines` },
  });
}

export function setPolicy(toolId: string, policy: Policy): void {
  toastId += 1;
  const tool = TOOL_BY_ID.get(toolId)!;
  setState({
    ...state,
    policies: { ...state.policies, [toolId]: policy },
    toast: {
      id: toastId,
      text:
        policy === "hands-off"
          ? `Hercule leaves ${tool.name} alone from now on`
          : policy === "pinned"
            ? `${tool.name} is pinned to ${tool.target}`
            : `${tool.name} follows the newest version`,
    },
  });
}

/** The clean idle workspaces automatic cleanup would take today at `days`. */
export const autoCleanTargets = (fleet: FleetState, days: 30 | 60): Workspace[] =>
  fleet.workspaces.filter((each) => !each.inUse && each.changes === 0 && each.lastUsedDays >= days);

export function setAutoClean(autoClean: AutoClean): void {
  toastId += 1;
  setState({
    ...state,
    autoClean,
    toast: {
      id: toastId,
      text:
        autoClean === "off"
          ? "Workspaces stay until you remove them"
          : `Clean workspaces idle for ${autoClean} days go by themselves, every night`,
    },
  });
}

/** Checks that the machine is away, offline or unreachable. */
export const isAway = (machine: Machine): boolean => machine.connectivity !== "online";
