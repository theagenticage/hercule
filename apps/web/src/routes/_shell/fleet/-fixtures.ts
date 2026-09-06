/**
 * The machine the two fleet tests both stub a controller with.
 *
 * The list and the page read the same runner from the same API, so one machine
 * serves both and each test spreads over it what its own case needs. Keeping
 * two copies meant a field added to the resource had to be added twice, in the
 * same shape, or the two screens would be tested against different machines.
 */

/** The version this controller answers `controller.read` with. */
export const CONTROLLER_VERSION = "0.4.2";

/** The timezone the stored settings put the reader in. */
export const ZONE = "Europe/Amsterdam";

export const GIB = 1024 * 1024 * 1024;

/** A runner as the API answers it, with everything either screen reads. */
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
    readonly identityPort: number;
  } | null;
  readonly watermark: {
    readonly diskFreeBytes: number;
    readonly availableMemoryBytes: number;
    readonly acceptingPlacements: boolean;
  } | null;
  readonly maxConcurrentSessions: number;
  readonly lastSeenAt: string | null;
  readonly negotiatedCapabilities: unknown;
  readonly protocolVersion: number | null;
}

/** A machine that has reported everything it can about itself. */
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
    identityPort: 4939,
  },
  watermark: {
    diskFreeBytes: 128 * GIB,
    availableMemoryBytes: 32 * GIB,
    acceptingPlacements: true,
  },
  maxConcurrentSessions: 4,
  lastSeenAt: "2026-09-05T09:14:00.000Z",
  negotiatedCapabilities: null,
  protocolVersion: 1,
};
