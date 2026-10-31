/**
 * Test fixtures, not exported from the package index. The tests of
 * `buildProviderRows` and `decideSessionsEmptyState` use the same runner, so
 * they share these fixtures.
 */
import type { ProviderInstance, Runner } from "@hercule/contract";

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

const DECLARED: ProviderInstance["declared"] = {
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

/** What makes a provider instance this one: its own id, the harness it runs, and its names. */
export interface InstanceIdentity {
  readonly id: string;
  readonly harnessId: string;
  readonly binaryName: string;
  readonly name: string;
}

export const CLAUDE_CODE_IDENTITY: InstanceIdentity = {
  id: "instance-claude-code",
  harnessId: "claude-code/claude-code",
  binaryName: "claude",
  name: "Claude Code",
};

export const CODEX_IDENTITY: InstanceIdentity = {
  id: "instance-codex",
  harnessId: "codex/codex",
  binaryName: "codex",
  name: "Codex",
};

export const PI_IDENTITY: InstanceIdentity = {
  id: "instance-pi",
  harnessId: "pi/pi",
  binaryName: "pi",
  name: "pi",
};

/**
 * Returns a provider instance with the given identity, an empty config and the
 * same declared capabilities for every harness. The display name equals the name.
 */
export const buildInstance = (
  identity: InstanceIdentity,
  snapshots: ProviderInstance["snapshots"] = [],
): ProviderInstance => ({
  id: identity.id,
  harnessId: identity.harnessId,
  name: identity.name,
  config: {},
  displayName: identity.name,
  binaryName: identity.binaryName,
  declared: DECLARED,
  secretFields: [],
  snapshots,
  createdAt: "2026-09-05T09:00:00.000Z",
  updatedAt: "2026-09-05T09:00:00.000Z",
});

/** Returns an instance's capability snapshot on `BARE`, logged in unless `fields` overrides it. */
export const buildSnapshot = (
  fields: Partial<ProviderInstance["snapshots"][number]> = {},
): ProviderInstance["snapshots"][number] => ({
  runnerId: BARE.id,
  probedAt: "2026-09-05T09:10:00.000Z",
  harnessVersion: "2.1.263",
  versionVerdict: "ok",
  auth: { status: "ok", identity: "rogier@example.com", planLabel: "Claude Max" },
  models: [{ slug: "default", name: "Default", imageInput: { maxBytes: null }, options: [] }],
  ...fields,
});
