/**
 * The records of the Fleet specimen (fleet.tsx): five machines in the states
 * the Fleet page and a machine's page draw, as the controller would return
 * them at the specimen's clock, Tuesday 29 September 2026, 09:41 UTC.
 *
 * The machines are listed in the order they joined, which is the order of
 * their ids and the order of the cards:
 *
 * - atlas: a Mac with 64 GB, so a desktop. Online, a cap of 16 with 12
 *   running, so its sessions draw as 16 blocks, and 5 Threads waiting for a
 *   slot, so its card offers Allow 17. It runs a runner one release behind the
 *   controller, and Codex 0.9.0, which is below the floor. Anthropic is signed
 *   in on it and OpenAI is not.
 * - beelink: a Linux server, and the controller's own machine. Online, a cap
 *   of 24 with 9 running, so its sessions draw as a bar. Healthy, but 85 % of
 *   its memory is in use, which turns the memory marigold.
 * - bosgame: a Linux server, online, whose free disk is below its limit.
 * - mini: a Mac laptop with 16 GB, offline since 09:12 today. Two of its
 *   Threads are open.
 * - studio: a Mac with 96 GB, online and set to take no new work. Its
 *   disk is 87 % full, which is the one need its card shows.
 *
 * The sidebar's seven threads run on atlas, and are 7 of its 12 running
 * sessions, so the sidebar and the Fleet page agree. Atlas's work is nine
 * groups in Running here: the seven rows of the sidebar (the Payout row also
 * holds two Agent sessions), one workflow run with two steps working and
 * five waiting for a slot, and Ada, an assistant.
 */
import type {
  ControllerInfo,
  EventWithFacts,
  Harness,
  ProviderAccount,
  Run,
  Runner,
  RunnerFacts,
  RunSummary,
  Session,
} from "@hercule/contract";
import {
  FORECAST_HISTORY_MS,
  type RunnerMetricsHistory,
} from "@hercule/client-core/metrics-history";
import { HARNESSES } from "@hercule/client-core/testing";
import {
  buildCheckout,
  buildRepo,
  buildSession,
  buildWorkspace,
} from "@hercule/client-core/threads/testing";
import {
  buildMachineMetrics,
  interpolate,
  driftWobble,
  wobble,
  workingDay,
  type MachineMetrics,
  type MachineStory,
} from "./fleet-metrics-fixture";
import { buildAtlasLog, buildJoinedLog } from "./fleet-activity-fixture";
import { RUN_RECORDS } from "./run-fixture";
import { ADA, buildAssistantSession } from "./assistant-states-fixture";
import { SPECIMEN_ACCOUNTS, SPECIMEN_NOW, SPECIMEN_RECORDS } from "./sidebar-fixture";
import type { SidebarRecords } from "./shell-page";

const GIB = 1024 ** 3;
const GB = 1e9;

/** The release of the controller. */
const CONTROLLER_VERSION = "0.4.2";

/** The ten gibibytes a machine's disk limit is by default. */
const DEFAULT_DISK_LIMIT_BYTES = 10 * GIB;

/** Returns the ISO instant `minutes` before the specimen's clock. */
const minutesAgo = (minutes: number): string =>
  new Date(SPECIMEN_NOW - minutes * 60_000).toISOString();

/** The ids of the five machines, which are UUIDv7-shaped so they sort in the order the machines joined. */
const ATLAS_ID = "01a0f0c0-0000-7000-8000-000000000001";
const BEELINK_ID = "01a0f0c0-0000-7000-8000-000000000002";
const BOSGAME_ID = "01a0f0c0-0000-7000-8000-000000000003";
const MINI_ID = "01a0f0c0-0000-7000-8000-000000000004";
const STUDIO_ID = "01a0f0c0-0000-7000-8000-000000000005";

/** What a machine has of one harness: the version it reports, or `null` when the harness is not installed. */
type HarnessVersions = Readonly<Record<string, string | null>>;

/** The one Codex version of the fixture that is below the oldest this Hercule works with. */
const BELOW_FLOOR_VERSION = "0.9.0";

/** Returns the facts of a machine with a disk of `diskTotalBytes` and the harnesses of `versions` installed. */
const buildFacts = (
  os: string,
  arch: string,
  totalMemoryBytes: number,
  diskTotalBytes: number,
  versions: HarnessVersions,
): RunnerFacts => ({
  os,
  arch,
  totalMemoryBytes,
  diskTotalBytes,
  docker: os === "linux",
  toolchains: [{ name: "node", version: "v24.8.0", path: "/usr/local/bin/node" }],
  harnesses: HARNESSES.map((harness) => ({
    name: harness.binaryName,
    present: versions[harness.id] !== null && versions[harness.id] !== undefined,
    ...(versions[harness.id] ? { path: `/usr/local/bin/${harness.binaryName}` } : {}),
  })),
  adapters: ["claude-code/claude-code", "codex/codex", "pi/pi"],
  identityPort: 4939,
});

/** Returns an online, active machine with the facts and the readings given, `cpu` being the last minute's mean and peak. */
const buildMachine = (
  id: string,
  name: string,
  over: Partial<Runner> & Pick<Runner, "facts" | "maxConcurrentSessions">,
  diskFreeBytes: number,
  availableMemoryBytes: number,
  cpu: { readonly averagePercent: number; readonly peakPercent: number },
): Runner => ({
  id,
  name,
  connectivity: "online",
  lifecycle: "active",
  reserved: false,
  version: CONTROLLER_VERSION,
  labels: [],
  metrics: { diskFreeBytes, availableMemoryBytes, cpu },
  diskWatermarkBytes: DEFAULT_DISK_LIMIT_BYTES,
  lastSeenAt: minutesAgo(0.5),
  ...over,
});

/** The harness versions each machine reports, by harness id. */
const ATLAS_VERSIONS: HarnessVersions = {
  "claude-code/claude-code": "2.0.84",
  "codex/codex": BELOW_FLOOR_VERSION,
  "pi/pi": null,
};
const BEELINK_VERSIONS: HarnessVersions = {
  "claude-code/claude-code": "2.0.84",
  "codex/codex": "0.46.0",
  "pi/pi": "0.9.2",
};
const BOSGAME_VERSIONS: HarnessVersions = {
  "claude-code/claude-code": "2.0.84",
  "codex/codex": null,
  "pi/pi": null,
};
const MINI_VERSIONS: HarnessVersions = {
  "claude-code/claude-code": "2.0.78",
  "codex/codex": "0.46.0",
  "pi/pi": null,
};
const STUDIO_VERSIONS: HarnessVersions = {
  "claude-code/claude-code": "2.0.84",
  "codex/codex": "0.46.0",
  "pi/pi": "0.9.2",
};

/** Atlas: a Mac with 64 GB and a 1,000 GB disk, one release behind, with 12 sessions running of a cap of 16. */
export const ATLAS: Runner = buildMachine(
  ATLAS_ID,
  "atlas",
  {
    facts: buildFacts("darwin", "arm64", 64 * GIB, 1000 * GB, ATLAS_VERSIONS),
    maxConcurrentSessions: 16,
    version: "0.4.1",
    labels: ["macos", "xcode"],
  },
  412 * GB,
  29 * GIB,
  { averagePercent: 34, peakPercent: 71 },
);

/** Beelink: a Linux server with 128 GB, 85 % of it in use, with a cap of 24. */
export const BEELINK: Runner = buildMachine(
  BEELINK_ID,
  "beelink",
  {
    facts: buildFacts("linux", "x64", 128 * GIB, 4000 * GB, BEELINK_VERSIONS),
    maxConcurrentSessions: 24,
    labels: ["linux", "docker"],
  },
  1900 * GB,
  19 * GIB,
  { averagePercent: 18, peakPercent: 52 },
);

/** Bosgame: a Linux server whose free disk, 6.2 GB, is below its limit of 10.7 GB. */
export const BOSGAME: Runner = buildMachine(
  BOSGAME_ID,
  "bosgame",
  {
    facts: buildFacts("linux", "x64", 32 * GIB, 500 * GB, BOSGAME_VERSIONS),
    maxConcurrentSessions: 8,
    labels: ["linux"],
  },
  6.2 * GB,
  21 * GIB,
  { averagePercent: 7, peakPercent: 22 },
);

/** Mini: a Mac laptop with 16 GB, offline since 09:12 today. Its readings are the last it sent. */
export const MINI: Runner = buildMachine(
  MINI_ID,
  "mini",
  {
    facts: buildFacts("darwin", "arm64", 16 * GIB, 500 * GB, MINI_VERSIONS),
    maxConcurrentSessions: 4,
    connectivity: "offline",
    lastSeenAt: "2026-09-29T09:12:00.000Z",
  },
  98 * GB,
  5.1 * GIB,
  { averagePercent: 12, peakPercent: 30 },
);

/** Studio: a Mac with 96 GB and a 4,000 GB disk that is 87 % full, online and told to take no new work. */
export const STUDIO: Runner = buildMachine(
  STUDIO_ID,
  "studio",
  {
    facts: buildFacts("darwin", "arm64", 96 * GIB, 4000 * GB, STUDIO_VERSIONS),
    maxConcurrentSessions: 8,
    lifecycle: "draining",
  },
  500 * GB,
  70 * GIB,
  { averagePercent: 4, peakPercent: 15 },
);

/**
 * The five machines in the order they joined, each with the harness versions
 * it reports. Kept as pairs so a machine and its versions cannot drift apart.
 */
const FLEET_MACHINES: ReadonlyArray<{
  readonly runner: Runner;
  readonly versions: HarnessVersions;
}> = [
  { runner: ATLAS, versions: ATLAS_VERSIONS },
  { runner: BEELINK, versions: BEELINK_VERSIONS },
  { runner: BOSGAME, versions: BOSGAME_VERSIONS },
  { runner: MINI, versions: MINI_VERSIONS },
  { runner: STUDIO, versions: STUDIO_VERSIONS },
];

const FLEET_RUNNERS: ReadonlyArray<Runner> = FLEET_MACHINES.map(({ runner }) => runner);

/** The shipped harnesses with what each machine reports of them. */
const FLEET_HARNESSES: ReadonlyArray<Harness> = HARNESSES.map((harness) => ({
  ...harness,
  runners: FLEET_MACHINES.map(({ runner, versions }) => {
    const version = versions[harness.id] ?? null;
    return {
      runnerId: runner.id,
      installed: version !== null,
      version,
      versionVerdict:
        version === null
          ? ("unknown" as const)
          : version === BELOW_FLOOR_VERSION
            ? ("below-floor" as const)
            : ("ok" as const),
    };
  }),
}));

/** The accounts' snapshot of one machine, signed in as `identity` or not signed in. */
const buildSnapshot = (
  account: ProviderAccount,
  runner: Runner,
  identity: string | null,
): ProviderAccount["snapshots"][number] => ({
  runnerId: runner.id,
  harnessId: account.defaultHarnessId,
  probedAt: minutesAgo(3),
  harnessVersion: null,
  versionVerdict: "unknown",
  auth:
    identity === null
      ? { status: "unauthenticated" }
      : { status: "ok", identity, planLabel: "Max" },
  models: account.snapshots[0]?.models ?? [],
});

/**
 * Returns the sidebar's account `account` as a per-machine account of the
 * fleet: signed in as `identity` on the machines of `signedInOn`, and not
 * signed in on the other machines that have its harness.
 */
const spreadAccount = (
  account: ProviderAccount,
  identity: string,
  signedInOn: ReadonlyArray<Runner>,
  notSignedInOn: ReadonlyArray<Runner>,
): ProviderAccount => {
  const snapshots = [
    ...signedInOn.map((runner) => buildSnapshot(account, runner, identity)),
    ...notSignedInOn.map((runner) => buildSnapshot(account, runner, null)),
  ];
  return {
    ...account,
    identity,
    planLabel: "Max",
    snapshots,
    readiness: snapshots.map((snapshot) => ({
      harnessId: snapshot.harnessId,
      runnerId: snapshot.runnerId,
      state: snapshot.auth.status === "ok" ? "ready" : "not-signed-in",
    })),
  };
};

/**
 * The two Provider Accounts that sign in on each machine. Anthropic is
 * signed in on atlas, beelink, bosgame and studio; OpenAI only on beelink and
 * studio, so on atlas it offers Sign in.
 */
const FLEET_ACCOUNTS: ReadonlyArray<ProviderAccount> = [
  spreadAccount(
    SPECIMEN_ACCOUNTS[0]!,
    "rogier@acme.com",
    [ATLAS, BEELINK, BOSGAME, STUDIO],
    [MINI],
  ),
  spreadAccount(SPECIMEN_ACCOUNTS[1]!, "rogier@acme.com", [BEELINK, STUDIO], [ATLAS, MINI]),
];

/**
 * Returns a session on `runnerId`, created `minutes` before the clock. A
 * queued session has not started, as the controller records it. The kind of a
 * session follows from its ids (`buildSession`): an agent id alone makes an
 * Agent session, and a run id with it makes a run's step session.
 */
const buildFleetSession = (
  id: string,
  runnerId: string,
  status: Session["status"],
  kind: "thread" | "agent" | "run",
  title: string,
  minutes: number,
  over: Partial<Session> = {},
): Session =>
  buildSession({
    id,
    title,
    runnerId,
    status,
    ...(kind === "thread" ? {} : { agentId: "agent-triage" }),
    ...(kind === "run" ? { runId: NIGHTLY_RUN_ID, stepId: "build" } : {}),
    createdAt: minutesAgo(minutes),
    startedAt: status === "queued" ? null : minutesAgo(minutes),
    lastActivityAt: minutesAgo(minutes),
    ...over,
  });

/** Returns `count` busy sessions of agents and runs on `runnerId`, newest first. */
const buildBusySessions = (runnerId: string, prefix: string, count: number): Session[] =>
  Array.from({ length: count }, (_, index) => {
    const kind = index % 2 === 0 ? "agent" : "run";
    return buildFleetSession(
      `${prefix}-${String(index + 1)}`,
      runnerId,
      "busy",
      kind,
      // A run's step session is titled "<workflow name> · <step id>".
      kind === "run"
        ? `${NIGHTLY_RUN.workflowName} · build`
        : `${prefix} session ${String(index + 1)}`,
      10 + index * 7,
    );
  });

/** The id of the one workflow run the fixture's step sessions belong to, which is running. */
const NIGHTLY_RUN_ID = "01a0f0c0-0000-7000-8000-0000000000a1";

/** The run, as `run.query { status: running }` lists it: the Nightly build, which started 31 minutes ago. */
const NIGHTLY_RUN: RunSummary = {
  id: NIGHTLY_RUN_ID,
  workflowId: "01a0f0c0-0000-7000-8000-0000000000a2",
  workflowName: "Nightly build",
  origin: { kind: "manual", actor: "user" },
  createdAt: minutesAgo(31),
  status: "running",
  startedAt: minutesAgo(31),
  activeStepIds: ["lint", "typecheck"],
  awaitedSignalIds: [],
};

/** The workspace of the Payout row, which holds the Thread and its two Agent sessions. */
const PAYOUT_WORKSPACE_ID = "ws-payout";

/** The repository the Payout row works in, and its worktree on atlas, where the Thread and its Agent sessions work. */
const PAYMENTS_REPO = buildRepo(
  "res-payments-api",
  "git@github.com:acme/payments-api.git",
  "github.com/acme/payments-api",
  ["p-payments-api"],
);
const PAYOUT_WORKSPACE = buildWorkspace({
  id: PAYOUT_WORKSPACE_ID,
  runnerId: ATLAS_ID,
  kind: "ephemeral",
  checkouts: [{ ...buildCheckout(PAYMENTS_REPO.id, "rogier/payout-report"), form: "worktree" }],
  sessionIds: ["s-payout", "atlas-payout-review", "atlas-payout-tests"],
});

/**
 * The sidebar's seven threads, which run on atlas. The Payout thread shares
 * its workspace with two Agent sessions, so the three are one row. A thread
 * started when it was created, which is the minutes ago its record says.
 */
const ATLAS_THREADS: ReadonlyArray<Session> = SPECIMEN_RECORDS.threads.map((thread) => ({
  ...thread,
  runnerId: ATLAS_ID,
  startedAt: thread.createdAt,
  ...(thread.id === "s-payout" ? { workspaceId: PAYOUT_WORKSPACE_ID } : {}),
}));

/** Atlas's sessions that are not Threads of the sidebar: the Payout row's two Agent sessions, Ada's, and the run's seven steps. */
const ATLAS_OTHER_SESSIONS: ReadonlyArray<Session> = [
  buildFleetSession(
    "atlas-payout-review",
    ATLAS_ID,
    "busy",
    "agent",
    "Review the payout totals",
    4,
    {
      workspaceId: PAYOUT_WORKSPACE_ID,
      agentId: "agent-reviewer",
    },
  ),
  buildFleetSession("atlas-payout-tests", ATLAS_ID, "busy", "agent", "Write the payout tests", 3, {
    workspaceId: PAYOUT_WORKSPACE_ID,
    agentId: "agent-tester",
  }),
  buildAssistantSession(ADA, {
    minutesAgo: 9,
    status: "busy",
    runnerId: ATLAS_ID,
    startedAt: minutesAgo(9),
  }),
  buildFleetSession("atlas-run-lint", ATLAS_ID, "busy", "run", "Nightly build · lint", 30, {
    stepId: "lint",
  }),
  buildFleetSession(
    "atlas-run-typecheck",
    ATLAS_ID,
    "busy",
    "run",
    "Nightly build · typecheck",
    28,
    {
      stepId: "typecheck",
    },
  ),
  ...Array.from({ length: 5 }, (_, index) =>
    buildFleetSession(
      `atlas-run-test-${String(index + 1)}`,
      ATLAS_ID,
      "queued",
      "run",
      `Nightly build · test-${String(index + 1)}`,
      7 - index,
      { stepId: `test-${String(index + 1)}` },
    ),
  ),
];

/**
 * Every session that has not exited: atlas runs 12 (the seven threads, the
 * Payout row's two Agent sessions, Ada's session and two steps of the run)
 * and has 5 steps waiting for a slot; beelink runs 9, bosgame 3 and studio 2;
 * mini holds 2 open Threads from before it went offline.
 */
const FLEET_SESSIONS: ReadonlyArray<Session> = [
  ...ATLAS_THREADS,
  ...ATLAS_OTHER_SESSIONS,
  ...buildBusySessions(BEELINK_ID, "beelink", 9),
  ...buildBusySessions(BOSGAME_ID, "bosgame", 3),
  buildFleetSession("mini-thread-1", MINI_ID, "idle", "thread", "Draft the release notes", 40),
  buildFleetSession("mini-thread-2", MINI_ID, "idle", "thread", "Review the ops runbook", 95),
  ...buildBusySessions(STUDIO_ID, "studio", 2),
];

/** What the controller says of itself: version 0.4.2, running on beelink. */
const FLEET_CONTROLLER: ControllerInfo = {
  id: "01a0f0c0-0000-7000-8000-0000000000c0",
  publicKey: "controller-key",
  version: CONTROLLER_VERSION,
  defaultRunnerId: ATLAS_ID,
  localRunnerId: BEELINK_ID,
  textGeneration: { model: null, lastFailure: null, unavailableReason: null },
};

/** How busy a working day is at the specimen's clock, which the quiet machines' numbers are scaled by. */
const BUSYNESS_NOW = workingDay(0);

/** Returns a story of `runner` whose numbers at the specimen's clock are the ones its record holds. */
const buildQuietStory = (
  runner: Runner,
  running: number,
  diskGrowthBytesPerDay: number,
  silentForHours: number,
): MachineStory => {
  const { facts, metrics } = runner;
  if (facts === null || metrics === null || metrics.cpu === undefined || metrics.cpu === null) {
    throw new Error(`The Fleet specimen needs ${runner.name} to report its facts and its CPU.`);
  }
  const totalMemoryBytes = facts.totalMemoryBytes;
  const diskTotalBytes = facts.diskTotalBytes ?? 0;
  const { averagePercent, peakPercent } = metrics.cpu;
  const memoryShareNow = 1 - metrics.availableMemoryBytes / totalMemoryBytes;
  const diskInUseNow = diskTotalBytes - metrics.diskFreeBytes;
  const busyness = (hoursAgo: number): number => workingDay(hoursAgo) / BUSYNESS_NOW;
  const cpuAverage = (hoursAgo: number): number =>
    averagePercent * (0.5 + 0.5 * busyness(hoursAgo)) * (1 + 0.25 * wobble(hoursAgo, 1));
  return {
    runnerId: runner.id,
    totalMemoryBytes,
    diskTotalBytes,
    sessionsRunning: (hoursAgo) => running * (0.4 + 0.6 * Math.min(1, busyness(hoursAgo))),
    sessionsQueued: () => 0,
    cpuAveragePercent: cpuAverage,
    cpuPeakPercent: (hoursAgo) =>
      cpuAverage(hoursAgo) + (peakPercent - averagePercent) * (0.6 + 0.4 * wobble(hoursAgo, 2)),
    memoryInUseShare: (hoursAgo) =>
      memoryShareNow + 0.02 * wobble(hoursAgo, 5) + 0.03 * (workingDay(hoursAgo) - BUSYNESS_NOW),
    diskInUseBytes: (hoursAgo) =>
      diskInUseNow - (diskGrowthBytesPerDay * hoursAgo) / 24 + 0.5 * GB * driftWobble(hoursAgo, 3),
    gaps: [],
    silentForHours,
  };
};

/**
 * Atlas's last 14 days. Yesterday from 14:00 to 16:30 it ran at its cap of 16
 * with 3 to 6 Threads waiting, and its CPU peaked near 100 %. From 16:40 to
 * 21:40 its memory stood near 80 %. Between 22:00 and 23:00 it sent nothing,
 * so every graph has a gap there. Its disk has filled by 33 GB a day, so the
 * limit is about 12 days away. At the clock it runs 12 sessions with 5
 * waiting.
 */
const ATLAS_STORY: MachineStory = (() => {
  const isWaiting = (hoursAgo: number): boolean => hoursAgo >= 17.2 && hoursAgo <= 19.7;
  const cpuAverage = (hoursAgo: number): number =>
    hoursAgo < 0.05
      ? 34
      : 6 + 30 * workingDay(hoursAgo) + 6 * wobble(hoursAgo, 1) + (isWaiting(hoursAgo) ? 28 : 0);
  return {
    runnerId: ATLAS_ID,
    totalMemoryBytes: 64 * GIB,
    diskTotalBytes: 1000 * GB,
    sessionsRunning: (hoursAgo) =>
      hoursAgo < 0.5 ? 12 : isWaiting(hoursAgo) ? 16 : 2 + 13 * workingDay(hoursAgo),
    sessionsQueued: (hoursAgo) =>
      hoursAgo < 0.55 ? 5 : isWaiting(hoursAgo) ? 4.5 + 1.5 * wobble(hoursAgo, 7) : 0,
    cpuAveragePercent: cpuAverage,
    cpuPeakPercent: (hoursAgo) =>
      hoursAgo < 0.05
        ? 71
        : cpuAverage(hoursAgo) +
          12 +
          30 * (0.5 + 0.5 * wobble(hoursAgo, 2)) +
          (isWaiting(hoursAgo) ? 8 : 0),
    memoryInUseShare: (hoursAgo) =>
      interpolate(
        [
          [0, 0.547],
          [0.5, 0.55],
          [3, 0.52],
          [9, 0.5],
          [12, 0.78],
          [13, 0.81],
          [16, 0.8],
          [17, 0.82],
          [18.5, 0.6],
          [24, 0.46],
          [400, 0.5],
        ],
        hoursAgo,
      ) +
      0.012 * wobble(hoursAgo, 6),
    diskInUseBytes: (hoursAgo) =>
      588 * GB - (33 * GB * hoursAgo) / 24 + 1.2 * GB * driftWobble(hoursAgo, 3),
    gaps: [[11.7, 10.7]],
    silentForHours: 0,
  };
})();

/** The histories of the five machines, by runner id. Mini went offline at 09:12 and sent nothing since. */
const FLEET_METRICS_BY_RUNNER: Readonly<Record<string, MachineMetrics>> = Object.fromEntries(
  (
    [
      ATLAS_STORY,
      buildQuietStory(BEELINK, 9, 8 * GB, 0),
      buildQuietStory(BOSGAME, 3, 0.4 * GB, 0),
      buildQuietStory(
        MINI,
        2,
        1 * GB,
        (SPECIMEN_NOW - Date.parse(MINI.lastSeenAt ?? "")) / 3_600_000,
      ),
      buildQuietStory(STUDIO, 2, 0, 0),
    ] as const
  ).map((story) => [story.runnerId, buildMachineMetrics(story)]),
);

/** The Runner Metrics the Fleet page and a machine's page read. */
export interface FleetMetricsRecords {
  /** A machine's five-minute points of the last 24 hours, by runner id. */
  readonly fiveMinutesByRunner: Readonly<Record<string, RunnerMetricsHistory>>;
  /** A machine's hour points of the last 14 days, by runner id. */
  readonly hoursByRunner: Readonly<Record<string, RunnerMetricsHistory>>;
  /** Every machine's hour points of the last 7 days, which the Fleet page forecasts from. */
  readonly fleetHours: RunnerMetricsHistory;
}

const FLEET_METRICS: FleetMetricsRecords = {
  fiveMinutesByRunner: Object.fromEntries(
    Object.entries(FLEET_METRICS_BY_RUNNER).map(([id, metrics]) => [id, metrics.fiveMinutes]),
  ),
  hoursByRunner: Object.fromEntries(
    Object.entries(FLEET_METRICS_BY_RUNNER).map(([id, metrics]) => [id, metrics.hours]),
  ),
  fleetHours: {
    points: Object.values(FLEET_METRICS_BY_RUNNER).flatMap(({ hours }) =>
      hours.points.filter((point) => Date.parse(point.at) >= SPECIMEN_NOW - FORECAST_HISTORY_MS),
    ),
    readAt: SPECIMEN_NOW,
  },
};

/**
 * The audit log of each machine, newest first, as `event.query { runnerId }`
 * returns it. Atlas has five days of activity; the others only joined.
 */
const FLEET_ACTIVITY: Readonly<Record<string, ReadonlyArray<EventWithFacts>>> = {
  [ATLAS_ID]: buildAtlasLog({
    providerAccountId: SPECIMEN_ACCOUNTS[0]!.id,
    runId: RUN_RECORDS.waiting.run.id,
    // The sidebar's seven threads, the sessions the page can name without a read of its own.
    sessionIds: ATLAS_THREADS.map((thread) => thread.id),
  }),
  [BEELINK_ID]: buildJoinedLog("2026-09-25T13:58:00.000Z"),
  [BOSGAME_ID]: buildJoinedLog("2026-09-26T08:12:00.000Z"),
  [MINI_ID]: buildJoinedLog("2026-09-26T08:20:00.000Z"),
  [STUDIO_ID]: buildJoinedLog("2026-09-27T10:05:00.000Z"),
};

/** What the Fleet page and a machine's page read besides the shell's lists. */
export interface FleetRecords {
  /** The harnesses with what each machine reports of them. */
  readonly harnesses: ReadonlyArray<Harness>;
  /** Every session that has not exited, which the machines' counts are made from. */
  readonly sessions: ReadonlyArray<Session>;
  /** The running runs, as `run.query { status: running }` lists them. Their workflow names are what a machine's Running here names the runs by. */
  readonly runningRuns: ReadonlyArray<RunSummary>;
  readonly controller: ControllerInfo;
  /** The Runner Metrics history the graphs and the forecasts are drawn from. */
  readonly metrics: FleetMetricsRecords;
  /** Each machine's audit log, newest first, by runner id. */
  readonly activity: Readonly<Record<string, ReadonlyArray<EventWithFacts>>>;
  /** The runs that spawned sessions on a machine, which name the workflow in an entry's sentence. */
  readonly runs: ReadonlyArray<Run>;
}

export const FLEET_RECORDS: FleetRecords = {
  harnesses: FLEET_HARNESSES,
  sessions: FLEET_SESSIONS,
  runningRuns: [NIGHTLY_RUN],
  controller: FLEET_CONTROLLER,
  metrics: FLEET_METRICS,
  activity: FLEET_ACTIVITY,
  runs: [RUN_RECORDS.waiting.run],
};

/**
 * The sidebar's lists with the five machines and their accounts, for a
 * specimen that opens Fleet. The sidebar lists Threads and Agent sessions,
 * and holds Ada, whose session runs on atlas.
 */
export const FLEET_SIDEBAR_RECORDS: SidebarRecords = {
  ...SPECIMEN_RECORDS,
  workspaces: [PAYOUT_WORKSPACE],
  resources: [PAYMENTS_REPO],
  threads: [...ATLAS_THREADS, ...ATLAS_OTHER_SESSIONS.filter(({ kind }) => kind === "agent")],
  assistants: [
    {
      assistant: ADA,
      currentSession: ATLAS_OTHER_SESSIONS.find(({ kind }) => kind === "assistant") ?? null,
    },
  ],
  runners: FLEET_RUNNERS,
  accounts: FLEET_ACCOUNTS,
};

/**
 * The sidebar's lists for an empty fleet: beelink, the controller's own
 * machine, is the only one online, so the page adds the dashed card that
 * invites the user to add a machine under the machines' cards.
 */
export const FLEET_ALONE_SIDEBAR_RECORDS: SidebarRecords = {
  ...FLEET_SIDEBAR_RECORDS,
  runners: FLEET_RUNNERS.map((runner) =>
    runner.id === BEELINK_ID ? runner : { ...runner, connectivity: "offline" },
  ),
};
