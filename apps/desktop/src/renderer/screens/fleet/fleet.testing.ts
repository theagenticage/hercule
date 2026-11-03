/**
 * Fixtures the Fleet page's component tests share: a runner builder and four
 * machines, each in a state the cards and rows draw differently. What each
 * machine needs is decided by `@hercule/client-core/fleet`, which has its own
 * tests.
 */
import type { FleetMachine } from "@hercule/client-core/fleet";
import type { Runner } from "@hercule/contract";

export const GIB = 1024 ** 3;
export const TIMEZONE = "UTC";
export const NOW = new Date("2026-11-02T14:00:00.000Z");

/** Returns an online runner with a cap of 16, 20 GiB of free disk and a 10 GiB disk limit. */
export const buildRunner = (overrides: Partial<Runner>): Runner => ({
  id: "01a06d02-beff-7037-9f5b-042822015952",
  name: "atlas",
  connectivity: "online",
  lifecycle: "active",
  reserved: false,
  version: "0.9.3",
  labels: [],
  facts: null,
  watermark: { diskFreeBytes: 20 * GIB, availableMemoryBytes: 8 * GIB },
  maxConcurrentSessions: 16,
  diskWatermarkBytes: 10 * GIB,
  lastSeenAt: "2026-11-02T09:12:00.000Z",
  ...overrides,
});

/** Runs 12 sessions under a cap of 16, with 5 more waiting for a slot that the cap does not give them. */
export const BUSY_MACHINE: FleetMachine = {
  runner: buildRunner({ id: "runner-busy", name: "atlas" }),
  running: 12,
  waiting: 5,
  waitingThreads: 5,
  openThreads: 5,
};

/** Has 5 GiB of free disk under a 10 GiB limit. */
export const FULL_DISK_MACHINE: FleetMachine = {
  runner: buildRunner({
    id: "runner-full",
    name: "forge",
    watermark: { diskFreeBytes: 5 * GIB, availableMemoryBytes: 8 * GIB },
  }),
  running: 2,
  waiting: 0,
  waitingThreads: 0,
  openThreads: 0,
};

/** Is offline, and was last heard from at 09:12. */
export const OFFLINE_MACHINE: FleetMachine = {
  runner: buildRunner({ id: "runner-off", name: "nomad", connectivity: "offline" }),
  running: 0,
  waiting: 0,
  waitingThreads: 0,
  openThreads: 0,
};

/** Is online but told to take no new work. */
export const DRAINING_MACHINE: FleetMachine = {
  runner: buildRunner({ id: "runner-drain", name: "dock", lifecycle: "draining" }),
  running: 1,
  waiting: 0,
  waitingThreads: 0,
  openThreads: 0,
};
