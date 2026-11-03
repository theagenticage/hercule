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
 * - studio: a Mac with 96 GB, online and set to take no new work.
 *
 * The sidebar's seven threads run on atlas, and are 7 of its 12 running
 * sessions, so the sidebar and the Fleet page agree.
 */
import type {
  ControllerInfo,
  Harness,
  ProviderAccount,
  Runner,
  RunnerFacts,
  Session,
} from "@hercule/contract";
import { HARNESSES } from "@hercule/client-core/testing";
import { buildSession } from "@hercule/client-core/threads/testing";
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

/** Returns the facts of a machine with the harnesses of `versions` installed. */
const buildFacts = (
  os: string,
  arch: string,
  totalMemoryBytes: number,
  versions: HarnessVersions,
): RunnerFacts => ({
  os,
  arch,
  totalMemoryBytes,
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

/** Returns an online, active machine with the facts and the readings given. */
const buildMachine = (
  id: string,
  name: string,
  over: Partial<Runner> & Pick<Runner, "facts" | "maxConcurrentSessions">,
  diskFreeBytes: number,
  availableMemoryBytes: number,
): Runner => ({
  id,
  name,
  connectivity: "online",
  lifecycle: "active",
  reserved: false,
  version: CONTROLLER_VERSION,
  labels: [],
  watermark: { diskFreeBytes, availableMemoryBytes },
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

/** Atlas: a Mac with 64 GB, one release behind, with 12 sessions running of a cap of 16. */
export const ATLAS: Runner = buildMachine(
  ATLAS_ID,
  "atlas",
  {
    facts: buildFacts("darwin", "arm64", 64 * GIB, ATLAS_VERSIONS),
    maxConcurrentSessions: 16,
    version: "0.4.1",
    labels: ["macos", "xcode"],
  },
  412 * GB,
  29 * GIB,
);

/** Beelink: a Linux server with 128 GB, 85 % of it in use, with a cap of 24. */
export const BEELINK: Runner = buildMachine(
  BEELINK_ID,
  "beelink",
  {
    facts: buildFacts("linux", "x64", 128 * GIB, BEELINK_VERSIONS),
    maxConcurrentSessions: 24,
    labels: ["linux", "docker"],
  },
  1900 * GB,
  19 * GIB,
);

/** Bosgame: a Linux server whose free disk, 6.2 GB, is below its limit of 10.7 GB. */
export const BOSGAME: Runner = buildMachine(
  BOSGAME_ID,
  "bosgame",
  {
    facts: buildFacts("linux", "x64", 32 * GIB, BOSGAME_VERSIONS),
    maxConcurrentSessions: 8,
    labels: ["linux"],
  },
  6.2 * GB,
  21 * GIB,
);

/** Mini: a Mac laptop with 16 GB, offline since 09:12 today. Its readings are the last it sent. */
export const MINI: Runner = buildMachine(
  MINI_ID,
  "mini",
  {
    facts: buildFacts("darwin", "arm64", 16 * GIB, MINI_VERSIONS),
    maxConcurrentSessions: 4,
    connectivity: "offline",
    lastSeenAt: "2026-09-29T09:12:00.000Z",
  },
  98 * GB,
  5.1 * GIB,
);

/** Studio: a Mac with 96 GB, online and told to take no new work. */
export const STUDIO: Runner = buildMachine(
  STUDIO_ID,
  "studio",
  {
    facts: buildFacts("darwin", "arm64", 96 * GIB, STUDIO_VERSIONS),
    maxConcurrentSessions: 8,
    lifecycle: "draining",
  },
  640 * GB,
  70 * GIB,
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

/** Returns a session on `runnerId`, created `minutes` before the clock. */
const buildFleetSession = (
  id: string,
  runnerId: string,
  status: Session["status"],
  kind: "thread" | "agent" | "run",
  title: string,
  minutes: number,
): Session =>
  buildSession({
    id,
    title,
    runnerId,
    status,
    ...(kind === "thread" ? {} : { agentId: "agent-triage" }),
    ...(kind === "run" ? { runId: "run-nightly" } : {}),
    createdAt: minutesAgo(minutes),
    lastActivityAt: minutesAgo(minutes),
  });

/** Returns `count` busy sessions of agents and runs on `runnerId`, newest first. */
const buildBusySessions = (runnerId: string, prefix: string, count: number): Session[] =>
  Array.from({ length: count }, (_, index) =>
    buildFleetSession(
      `${prefix}-${String(index + 1)}`,
      runnerId,
      "busy",
      index % 2 === 0 ? "agent" : "run",
      `${prefix} session ${String(index + 1)}`,
      10 + index * 7,
    ),
  );

/** The sidebar's seven threads, which run on atlas. */
const ATLAS_THREADS: ReadonlyArray<Session> = SPECIMEN_RECORDS.threads.map((thread) => ({
  ...thread,
  runnerId: ATLAS_ID,
}));

/**
 * Every session that has not exited: atlas runs 12 (the seven threads and
 * five of agents and runs) and has 5 Threads waiting for a slot; beelink runs
 * 9, bosgame 3 and studio 2; mini holds 2 open Threads from before it went
 * offline.
 */
const FLEET_SESSIONS: ReadonlyArray<Session> = [
  ...ATLAS_THREADS,
  ...buildBusySessions(ATLAS_ID, "atlas", 5),
  ...Array.from({ length: 5 }, (_, index) =>
    buildFleetSession(
      `atlas-wait-${String(index + 1)}`,
      ATLAS_ID,
      "queued",
      "thread",
      `Waiting thread ${String(index + 1)}`,
      3 + index,
    ),
  ),
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

/** What the Fleet page and a machine's page read besides the shell's lists. */
export interface FleetRecords {
  /** The harnesses with what each machine reports of them. */
  readonly harnesses: ReadonlyArray<Harness>;
  /** Every session that has not exited, which the machines' counts are made from. */
  readonly sessions: ReadonlyArray<Session>;
  readonly controller: ControllerInfo;
}

export const FLEET_RECORDS: FleetRecords = {
  harnesses: FLEET_HARNESSES,
  sessions: FLEET_SESSIONS,
  controller: FLEET_CONTROLLER,
};

/** The sidebar's lists with the five machines and their accounts, for a specimen that opens Fleet. */
export const FLEET_SIDEBAR_RECORDS: SidebarRecords = {
  ...SPECIMEN_RECORDS,
  threads: ATLAS_THREADS,
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
