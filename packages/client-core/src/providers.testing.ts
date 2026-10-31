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

/** The instance id and the binary's name of each harness a test builds an instance for. */
const HARNESSES: Record<string, { readonly instanceId: string; readonly binaryName: string }> = {
  "claude-code/claude-code": { instanceId: "instance-claude-code", binaryName: "claude" },
  "codex/codex": { instanceId: "instance-codex", binaryName: "codex" },
  "pi/pi": { instanceId: "instance-pi", binaryName: "pi" },
};

/**
 * Returns a provider instance of the harness `harnessId`, a qualified id such as
 * `claude-code/claude-code`. Throws for an id not in `HARNESSES`, so a stale or bare id fails the test.
 */
export const buildInstance = (
  harnessId: string,
  displayName: string,
  snapshots: ProviderInstance["snapshots"] = [],
): ProviderInstance => {
  const harness = HARNESSES[harnessId];
  if (harness === undefined) throw new Error(`No test harness registered for "${harnessId}"`);
  return {
    id: harness.instanceId,
    harnessId,
    name: displayName,
    config: {},
    displayName,
    binaryName: harness.binaryName,
    declared: DECLARED,
    secretFields: [],
    snapshots,
    createdAt: "2026-09-05T09:00:00.000Z",
    updatedAt: "2026-09-05T09:00:00.000Z",
  };
};

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
