/**
 * Fixtures the Fleet page's component tests share: a runner builder and five
 * machines, each in a state the cards and rows draw differently. The machines
 * are what `describeFleetPage` of `@hercule/client-core/fleet` builds from
 * their runners, which is what the page hands its cards; its own tests cover
 * what it decides.
 */
import { describeFleetPage, type MachineSummary } from "@hercule/client-core/fleet";
import type { Runner, RunnerFacts, RunnerMetrics } from "@hercule/contract";

export const GIB = 1024 ** 3;
export const TIMEZONE = "UTC";
export const NOW = new Date("2026-11-02T14:00:00.000Z");

/**
 * Returns the facts of a Linux machine with 32 GiB of memory and a disk of
 * 500 GiB, which `overrides` change.
 */
export const buildFacts = (overrides: Partial<RunnerFacts> = {}): RunnerFacts => ({
  os: "linux",
  arch: "x64",
  totalMemoryBytes: 32 * GIB,
  diskTotalBytes: 500 * GIB,
  docker: false,
  toolchains: [],
  harnesses: [],
  adapters: [],
  identityPort: 7000,
  ...overrides,
});

/** Returns the metrics of a machine with 20 GiB of free disk, 8 GiB of available memory and a CPU at 12% (peak 40%), which `overrides` change. */
export const buildMetrics = (overrides: Partial<RunnerMetrics> = {}): RunnerMetrics => ({
  diskFreeBytes: 20 * GIB,
  availableMemoryBytes: 8 * GIB,
  cpu: { averagePercent: 12, peakPercent: 40 },
  ...overrides,
});

/**
 * Returns an online runner with a cap of 16, 20 GiB of free disk and a 10 GiB
 * disk limit. Its facts are `null`, so its cards show free disk space and no
 * percentages; give it `facts: buildFacts()` for a runner that reports its
 * disk's size.
 */
export const buildRunner = (overrides: Partial<Runner>): Runner => ({
  id: "01a06d02-beff-7037-9f5b-042822015952",
  name: "atlas",
  connectivity: "online",
  lifecycle: "active",
  reserved: false,
  version: "0.9.3",
  labels: [],
  facts: null,
  metrics: buildMetrics(),
  maxConcurrentSessions: 16,
  diskWatermarkBytes: 10 * GIB,
  lastSeenAt: "2026-11-02T09:12:00.000Z",
  ...overrides,
});

const RUNNERS: readonly Runner[] = [
  buildRunner({ id: "runner-busy", name: "atlas" }),
  buildRunner({
    id: "runner-full",
    name: "forge",
    metrics: buildMetrics({ diskFreeBytes: 5 * GIB }),
  }),
  buildRunner({
    id: "runner-87",
    name: "orbit",
    facts: buildFacts(),
    metrics: buildMetrics({ diskFreeBytes: 65 * GIB }),
  }),
  buildRunner({ id: "runner-off", name: "nomad", connectivity: "offline" }),
  buildRunner({ id: "runner-drain", name: "dock", lifecycle: "draining" }),
];

const NO_QUEUE = { waiting: 0, waitingThreads: 0, openThreads: 0 };

const MACHINES = describeFleetPage(
  RUNNERS,
  {
    "runner-busy": { running: 12, waiting: 5, waitingThreads: 5, openThreads: 5 },
    "runner-full": { running: 2, ...NO_QUEUE },
    "runner-drain": { running: 1, ...NO_QUEUE },
  },
  null,
  TIMEZONE,
  NOW,
).machines;

const pickMachine = (runnerId: string): MachineSummary => {
  const machine = MACHINES.find((each) => each.runnerId === runnerId);
  if (machine === undefined) throw new Error(`The fixture has no machine ${runnerId}.`);
  return machine;
};

/** Runs 12 sessions under a cap of 16, with 5 more waiting for a slot that the cap does not give them. */
export const BUSY_MACHINE = pickMachine("runner-busy");

/** Has 5 GiB of free disk under a 10 GiB limit. */
export const FULL_DISK_MACHINE = pickMachine("runner-full");

/** Has 65 GiB free of a 500 GiB disk, which is 87% full, and reports its disk's size. */
export const NEARLY_FULL_DISK_MACHINE = pickMachine("runner-87");

/** Is offline, and was last heard from at 09:12. */
export const OFFLINE_MACHINE = pickMachine("runner-off");

/** Is online but told to take no new work. */
export const DRAINING_MACHINE = pickMachine("runner-drain");
