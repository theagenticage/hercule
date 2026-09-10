/**
 * The machine the two fleet tests both stub a controller with. One copy, so a
 * field added to the resource cannot reach one screen's test and not the
 * other's; each test spreads over it what its own case needs.
 */

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
