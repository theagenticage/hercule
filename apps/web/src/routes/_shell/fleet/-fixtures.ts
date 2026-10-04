/**
 * The runner and session fixtures that both fleet tests use to stub the
 * controller. They share one copy so that a field added to the runner record
 * reaches both tests. Each test spreads its own overrides over these.
 */
import type { Session } from "@hercule/contract";

export const CONTROLLER_VERSION = "0.4.2";

export const ZONE = "Europe/Amsterdam";

export const GIB = 1024 * 1024 * 1024;

export interface Fixture {
  readonly id: string;
  readonly name: string;
  readonly connectivity: string;
  readonly lifecycle: string;
  readonly reserved: boolean;
  readonly version: string | null;
  readonly labels: readonly string[];
  readonly facts: {
    readonly os: string;
    readonly arch: string;
    readonly totalMemoryBytes: number;
    readonly docker: boolean;
    readonly toolchains: readonly { name: string; version: string; path: string }[];
    readonly providers: readonly { name: string; present: boolean }[];
    readonly adapters: readonly string[];
    readonly identityPort: number;
  } | null;
  readonly watermark: {
    readonly diskFreeBytes: number;
    readonly availableMemoryBytes: number;
  } | null;
  readonly maxConcurrentSessions: number;
  readonly diskWatermarkBytes: number;
  readonly lastSeenAt: string | null;
  readonly negotiatedCapabilities: unknown;
  readonly protocolVersion: number | null;
}

export const MOSS: Fixture = {
  id: "01a06d02-beff-7037-9f5b-042822015952",
  name: "moss",
  connectivity: "online",
  lifecycle: "active",
  reserved: false,
  version: CONTROLLER_VERSION,
  labels: ["gpu", "primary"],
  facts: {
    os: "darwin",
    arch: "arm64",
    totalMemoryBytes: 64 * GIB,
    docker: true,
    toolchains: [
      { name: "git", version: "2.50.1", path: "/usr/bin/git" },
      { name: "gh", version: "2.99.0", path: "/opt/homebrew/bin/gh" },
    ],
    providers: [{ name: "claude", present: true }],
    adapters: ["claude-code"],
    identityPort: 4939,
  },
  watermark: {
    diskFreeBytes: 128 * GIB,
    availableMemoryBytes: 32 * GIB,
  },
  maxConcurrentSessions: 4,
  diskWatermarkBytes: 10 * GIB,
  lastSeenAt: "2026-09-05T09:14:00.000Z",
  negotiatedCapabilities: null,
  protocolVersion: 1,
};

/**
 * A session on `MOSS`, as `session.query` returns it. The runner page reads
 * only a few of these fields; the rest are here because the contract requires
 * them, and a screen should never get a partial record.
 */
const BASE_SESSION: Session = {
  id: "01a06d02-2000-7000-8000-000000000001",
  title: "Fix the login bug",
  status: "busy",
  resumable: false,
  resumeHeld: false,
  permissionProfileId: "01a06d02-3000-7000-8000-000000000001",
  agentId: null,
  conversationId: null,
  runId: null,
  stepId: null,
  instanceId: "01a06d02-1000-7000-8000-000000000001",
  runnerId: MOSS.id,
  workspaceId: null,
  projectId: null,
  requestedAccessMode: "approval-required",
  accessMode: "approval-required",
  nativeSessionId: null,
  modelSelection: { model: "claude-sonnet-5", options: {} },
  parentSessionId: null,
  openRequest: null,
  createdAt: "2026-09-05T09:00:00.000Z",
  startedAt: "2026-09-05T09:00:00.000Z",
  exitedAt: null,
  lastActivityAt: "2026-09-05T09:00:00.000Z",
  unenforced: [],
};

/**
 * Builds a session on `MOSS` from `overrides`.
 *
 * `at` sets both `createdAt` and `lastActivityAt`, so a test can set a
 * session's age without knowing which of the two the row reads. For a queued
 * session, which has never run, `startedAt` stays null; otherwise `at` sets it
 * too.
 */
export const buildSessionFixture = (
  overrides: Partial<Session> & { readonly id: string; readonly at?: string },
): Session => {
  const { at, ...fields } = overrides;
  const queued = fields.status === "queued";
  return {
    ...BASE_SESSION,
    ...(at === undefined
      ? {}
      : { createdAt: at, lastActivityAt: at, startedAt: queued ? null : at }),
    ...fields,
  };
};
