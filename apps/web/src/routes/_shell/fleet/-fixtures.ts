/**
 * The machine the two fleet tests both stub a controller with. One copy, so a
 * field added to the resource cannot reach one screen's test and not the
 * other's; each test spreads over it what its own case needs.
 */
import type { Session } from "@hydra/contract";

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
 * A session on `MOSS`, as the API answers `session.query`. The runner page
 * reads a handful of these fields; the rest are here because the contract has
 * them and a screen must not be handed a half record.
 */
const BASE_SESSION: Session = {
  id: "01a06d02-2000-7000-8000-000000000001",
  title: "Fix the login bug",
  status: "busy",
  resumable: false,
  permissionProfileId: "01a06d02-3000-7000-8000-000000000001",
  instanceId: "01a06d02-1000-7000-8000-000000000001",
  runnerId: MOSS.id,
  workspaceId: null,
  requestedAccessMode: "approval-required",
  accessMode: "approval-required",
  nativeSessionId: null,
  modelSelection: { model: "claude-sonnet-5", options: {} },
  parentSessionId: null,
  createdAt: "2026-09-05T09:00:00.000Z",
  startedAt: "2026-09-05T09:00:00.000Z",
  exitedAt: null,
  lastActivityAt: "2026-09-05T09:00:00.000Z",
};

/**
 * One session on the machine. A queued session has never run, so its
 * `startedAt` is null and its two instants - `createdAt` and
 * `lastActivityAt` - are the same; `at` sets both, which is what lets a test
 * name a session's age without deciding which of the two the row reads.
 */
export const sessionFixture = (
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
