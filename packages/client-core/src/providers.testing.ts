/**
 * Test-only, not exported from the package index. `providerRows` and
 * `sessionsEmptyState` read the same machine, so they share one arrangement of it.
 */
import type { ProviderInstance, Runner } from "@hydra/contract";

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
    providers: [
      { name: "claude", present: false },
      { name: "codex", present: false },
      { name: "pi", present: false },
    ],
    adapters: ["claude-code"],
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
    providers: [
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

export const instance = (
  providerId: string,
  displayName: string,
  snapshots: ProviderInstance["snapshots"] = [],
): ProviderInstance => ({
  id: `instance-${providerId}`,
  providerId,
  name: displayName,
  config: {},
  displayName,
  binaryName: providerId === "claude-code" ? "claude" : providerId,
  declared: DECLARED,
  snapshots,
  createdAt: "2026-09-05T09:00:00.000Z",
  updatedAt: "2026-09-05T09:00:00.000Z",
});

/** What the machine last reported about one instance; logged in unless overridden. */
export const snapshot = (
  fields: Partial<ProviderInstance["snapshots"][number]> = {},
): ProviderInstance["snapshots"][number] => ({
  runnerId: BARE.id,
  probedAt: "2026-09-05T09:10:00.000Z",
  harnessVersion: "2.1.263",
  versionVerdict: "ok",
  auth: { status: "ok", identity: "rogier@example.com", planLabel: "Claude Max" },
  models: [{ slug: "default", name: "Default", options: [] }],
  ...fields,
});
