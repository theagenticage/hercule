import { describe, expect, it } from "vitest";
import type {
  Runner,
  RunnerFacts,
  RunnerMetricsPoint,
  Session,
  SessionKind,
  SessionStatus,
} from "@hercule/contract";
import {
  countRunnerSessions,
  describeFleetPage,
  type FleetLead,
  type MachineSummary,
  type SessionCountsByRunner,
} from "./fleet";
import { forecastDiskLimit } from "./disk-forecast";
import { buildFleetMachine, decideMachineNeed } from "./machine";
import { EMPTY_RUNNER_METRICS_HISTORY, type RunnerMetricsHistory } from "./metrics-history";

const GIB = 1024 ** 3;
const TIMEZONE = "UTC";
const TODAY = new Date("2026-11-02T14:00:00.000Z");
const SEEN_TODAY = "2026-11-02T09:12:00.000Z";

/** Returns an online, active runner with a cap of 16, 20 GiB of free disk and a 10 GiB limit. */
const buildRunner = (overrides: Partial<Runner> = {}): Runner => ({
  id: "01a06d02-beff-7037-9f5b-042822015952",
  name: "atlas",
  connectivity: "online",
  lifecycle: "active",
  reserved: false,
  version: "0.9.3",
  labels: [],
  facts: null,
  metrics: { diskFreeBytes: 20 * GIB, availableMemoryBytes: 8 * GIB },
  maxConcurrentSessions: 16,
  diskWatermarkBytes: 10 * GIB,
  lastSeenAt: SEEN_TODAY,
  ...overrides,
});

const buildFacts = (overrides: Partial<RunnerFacts> = {}): RunnerFacts => ({
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 16 * GIB,
  docker: false,
  toolchains: [],
  harnesses: [],
  adapters: [],
  identityPort: 7000,
  ...overrides,
});

const DISK_TOTAL = 1000e9;

/** Returns the overrides of a runner whose 1,000 GB disk has `diskFreeBytes` left and whose total it reports. */
const withDisk = (diskFreeBytes: number): Partial<Runner> => ({
  facts: buildFacts({ diskTotalBytes: DISK_TOTAL }),
  metrics: { diskFreeBytes, availableMemoryBytes: 8 * GIB },
});

let nextSession = 0;

/** Returns a session on a runner; only its runner, status and kind matter here. */
const buildSession = (runnerId: string, status: SessionStatus, kind: SessionKind = "thread") => {
  nextSession += 1;
  return {
    id: `01a06d02-2000-7000-8000-${String(nextSession).padStart(12, "0")}`,
    title: "Fix the login bug",
    kind,
    role: null,
    status,
    resumable: false,
    resumeHeld: false,
    toolCalls: 0,
    permissionProfileId: "01a06d02-3000-7000-8000-000000000001",
    agentId: null,
    conversationId: null,
    runId: null,
    stepId: null,
    providerAccountId: "01a06d02-1000-7000-8000-000000000001",
    harnessId: "claude-code/claude-code",
    runnerId,
    workspaceId: null,
    projectId: null,
    requestedAccessMode: "approval-required",
    accessMode: "approval-required",
    nativeSessionId: null,
    modelSelection: { model: "claude-sonnet-5", options: {} },
    parentSessionId: null,
    openRequests: [],
    openPermissionRequests: [],
    createdAt: "2026-11-02T09:00:00.000Z",
    startedAt: null,
    exitedAt: null,
    lastActivityAt: "2026-11-02T09:00:00.000Z",
    unenforced: [],
  } satisfies Session;
};

type Counts = SessionCountsByRunner[string];

/** Returns the counts of a runner's sessions; what a test does not name is 0. */
const buildCounts = (counts: Partial<Counts> = {}): Counts => ({
  running: 0,
  waiting: 0,
  waitingThreads: 0,
  openThreads: 0,
  ...counts,
});

let nextRunner = 0;

/** A runner with the counts of its sessions, as a test names a machine of the Fleet. */
interface TestMachine {
  readonly runner: Runner;
  readonly counts: Counts;
}

/** Returns a machine; each gets an id that sorts after the one before it. */
const buildMachine = (
  runnerOverrides: Partial<Runner> = {},
  counts: Partial<Counts> = {},
): TestMachine => {
  nextRunner += 1;
  const id = `01a06d02-${String(nextRunner).padStart(4, "0")}-7000-8000-000000000001`;
  return { runner: buildRunner({ id, ...runnerOverrides }), counts: buildCounts(counts) };
};

/** Returns a machine whose slots are all taken and with threads waiting. */
const buildFullMachine = (waiting: number, runnerOverrides: Partial<Runner> = {}): TestMachine =>
  buildMachine(
    { maxConcurrentSessions: 12, ...runnerOverrides },
    { running: 12, waiting, waitingThreads: waiting },
  );

const HOUR_MS = 60 * 60 * 1000;
const READ_AT = TODAY.getTime();
const FALL_PER_DAY = 20e9;

/**
 * Returns the hour points of a machine whose free disk falls 20 GB a day and,
 * on that line, reaches the machine's disk limit `daysToLimit` days after
 * `READ_AT`, which is when the points were read. They span the last 3 days.
 */
const buildHistory = ({ runner }: TestMachine, daysToLimit: number): RunnerMetricsHistory => {
  const freeAtReadAt = runner.diskWatermarkBytes + daysToLimit * FALL_PER_DAY;
  const points = Array.from({ length: 73 }, (_, hour): RunnerMetricsPoint => ({
    runnerId: runner.id,
    at: new Date(READ_AT - (72 - hour) * HOUR_MS).toISOString(),
    minutes: 60,
    diskFreeBytes: freeAtReadAt + ((72 - hour) / 24) * FALL_PER_DAY,
    availableMemoryBytes: 8 * GIB,
    availableMemoryLowestBytes: 8 * GIB,
    cpuAveragePercent: null,
    cpuPeakPercent: null,
    sessionsRunning: 0,
    sessionsQueued: 0,
  }));
  return { points, readAt: READ_AT };
};

/** Returns a machine with a 1,000 GB disk that is 75% full, as a forecast needs the disk's total size. */
const buildForecastMachine = (): TestMachine => buildMachine(withDisk(250e9));

const describePage = (
  machines: readonly TestMachine[],
  localRunnerId: string | null = null,
  timezone = TIMEZONE,
  metricsHistory: RunnerMetricsHistory = EMPTY_RUNNER_METRICS_HISTORY,
) =>
  describeFleetPage(
    machines.map(({ runner }) => runner),
    Object.fromEntries(machines.map(({ runner, counts }) => [runner.id, counts])),
    metricsHistory,
    localRunnerId,
    timezone,
    TODAY,
  );

/** Returns what the Fleet page draws for one machine. */
const summarize = (
  runnerOverrides: Partial<Runner> = {},
  counts: Partial<Counts> = {},
): MachineSummary => describePage([buildMachine(runnerOverrides, counts)]).machines[0]!;

const findNeed = (
  { runner, counts }: TestMachine,
  timezone = TIMEZONE,
  metricsHistory: RunnerMetricsHistory = EMPTY_RUNNER_METRICS_HISTORY,
) =>
  decideMachineNeed(
    buildFleetMachine(runner, { [runner.id]: counts }),
    forecastDiskLimit(metricsHistory.points, runner, metricsHistory.readAt),
    timezone,
    TODAY,
  );

const readText = (parts: FleetLead["headline"]): string => parts.map((part) => part.text).join("");

describe("countRunnerSessions", () => {
  it("counts running sessions, waiting sessions and waiting Threads per runner", () => {
    const sessions = [
      buildSession("atlas", "starting"),
      buildSession("atlas", "idle", "agent"),
      buildSession("atlas", "busy", "run"),
      buildSession("atlas", "queued", "thread"),
      buildSession("atlas", "queued", "assistant"),
      buildSession("moss", "busy"),
    ];

    expect(countRunnerSessions(sessions)).toEqual({
      atlas: { running: 3, waiting: 2, waitingThreads: 1, openThreads: 2 },
      moss: { running: 1, waiting: 0, waitingThreads: 0, openThreads: 1 },
    });
  });

  it("counts the Threads that have not exited, and no other session", () => {
    const sessions = [
      buildSession("atlas", "busy", "thread"),
      buildSession("atlas", "queued", "thread"),
      buildSession("atlas", "exited", "thread"),
      buildSession("atlas", "busy", "agent"),
    ];

    expect(countRunnerSessions(sessions)["atlas"]?.openThreads).toBe(2);
  });

  it("counts a session that has exited as nothing", () => {
    expect(countRunnerSessions([buildSession("atlas", "exited")])).toEqual({
      atlas: { running: 0, waiting: 0, waitingThreads: 0, openThreads: 0 },
    });
  });

  it("has no entry for a runner without sessions", () => {
    expect(countRunnerSessions([])).toEqual({});
  });
});

describe("describeFleetPage machines", () => {
  it("drops retired runners and orders the rest by when they joined", () => {
    const first = buildRunner({ id: "01a06d02-0001-7000-8000-000000000001", name: "first" });
    const second = buildRunner({ id: "01a06d02-0002-7000-8000-000000000001", name: "second" });
    const retired = buildRunner({
      id: "01a06d02-0003-7000-8000-000000000001",
      lifecycle: "retired",
    });

    const { machines } = describeFleetPage(
      [second, retired, first],
      {},
      EMPTY_RUNNER_METRICS_HISTORY,
      null,
      TIMEZONE,
      TODAY,
    );

    expect(machines.map((machine) => machine.name)).toEqual(["first", "second"]);
  });

  it("gives each machine the counts of its runner, and none to a runner without sessions", () => {
    const atlas = buildRunner({ id: "01a06d02-0001-7000-8000-000000000001" });
    const moss = buildRunner({ id: "01a06d02-0002-7000-8000-000000000001" });
    const counts = countRunnerSessions([
      buildSession(atlas.id, "busy"),
      buildSession(atlas.id, "queued"),
    ]);

    const { machines } = describeFleetPage(
      [atlas, moss],
      counts,
      EMPTY_RUNNER_METRICS_HISTORY,
      null,
      TIMEZONE,
      TODAY,
    );

    expect(machines.map((machine) => [machine.drawing.running, machine.drawing.waiting])).toEqual([
      [1, 1],
      [0, 0],
    ]);
  });

  it("ignores the counts of a runner that is not in the list", () => {
    const atlas = buildRunner();
    const counts = countRunnerSessions([
      buildSession("01a06d02-9999-7000-8000-000000000001", "busy"),
    ]);

    const page = describeFleetPage(
      [atlas],
      counts,
      EMPTY_RUNNER_METRICS_HISTORY,
      null,
      TIMEZONE,
      TODAY,
    );

    expect(page.machines).toEqual(
      describeFleetPage([atlas], {}, EMPTY_RUNNER_METRICS_HISTORY, null, TIMEZONE, TODAY).machines,
    );
  });

  it("forecasts each machine from the points of its own runner", () => {
    const soon = buildMachine({ ...withDisk(250e9), id: "01a06d02-0001-7000-8000-000000000001" });
    const later = buildMachine({ ...withDisk(250e9), id: "01a06d02-0002-7000-8000-000000000001" });
    const history: RunnerMetricsHistory = {
      points: [...buildHistory(soon, 12).points, ...buildHistory(later, 40).points],
      readAt: READ_AT,
    };

    const { machines } = describePage([later, soon], null, TIMEZONE, history);

    expect(machines.map((machine) => machine.need?.line)).toEqual([
      "Disk reaches its limit in about 12 days",
      undefined,
    ]);
  });

  it("names the machine, the runner it is and the icon it gets", () => {
    const machine = buildMachine({ name: "atlas", facts: buildFacts({ os: "linux" }) });

    expect(describePage([machine]).machines[0]).toMatchObject({
      runnerId: machine.runner.id,
      name: "atlas",
      kind: "server",
    });
  });
});

describe("decideMachineNeed", () => {
  it("is none for a healthy machine", () => {
    expect(findNeed(buildMachine())).toBeUndefined();
  });

  it("says when an offline machine was last seen", () => {
    const need = findNeed(buildMachine({ connectivity: "offline" }));

    expect(need).toEqual({ kind: "offline", hue: "fail", line: "Offline since 09:12" });
  });

  it("names the day when the machine was last seen on another day", () => {
    const machine = buildMachine({
      connectivity: "offline",
      lastSeenAt: "2026-10-30T09:12:00.000Z",
    });

    expect(findNeed(machine)?.line).toBe("Offline since Fri 09:12");
  });

  it("reads the time in the user's timezone", () => {
    expect(findNeed(buildMachine({ connectivity: "offline" }), "Europe/Amsterdam")?.line).toBe(
      "Offline since 10:12",
    );
  });

  it("words a time relative to the date of today, whatever the time of day", () => {
    const { runner } = buildMachine({ connectivity: "offline" });
    const startOfDay = new Date("2026-11-02T00:00:00.000Z");

    expect(decideMachineNeed(buildFleetMachine(runner, {}), null, TIMEZONE, startOfDay)?.line).toBe(
      "Offline since 09:12",
    );
  });

  it("leaves out the time of a machine that was never seen", () => {
    const machine = buildMachine({ connectivity: "offline", lastSeenAt: null });

    expect(findNeed(machine)?.line).toBe("Offline");
  });

  it("says when an unreachable machine was last heard from", () => {
    const need = findNeed(buildMachine({ connectivity: "unreachable" }));

    expect(need).toEqual({
      kind: "unreachable",
      hue: "fail",
      line: "Not heard from since 09:12",
    });
  });

  it("reports a disk below its limit", () => {
    const machine = buildMachine({
      metrics: { diskFreeBytes: 5 * GIB, availableMemoryBytes: 8 * GIB },
    });

    expect(findNeed(machine)).toEqual({
      kind: "disk-below-limit",
      hue: "fail",
      line: "Disk below its limit. It takes no new sessions.",
    });
  });

  it("reports waiting Threads with the cap that lets them start", () => {
    expect(findNeed(buildFullMachine(3))).toEqual({
      kind: "waiting",
      hue: "you",
      line: "3 threads wait for a slot",
      allow: 15,
      allowHint: "Lets 15 sessions run here at once: the 12 running and the 3 waiting.",
    });
  });

  it("uses singular words for one waiting Thread", () => {
    const need = findNeed(buildFullMachine(1));

    expect(need).toMatchObject({
      line: "1 thread waits for a slot",
      allow: 13,
      allowHint: "Lets 13 sessions run here at once: the 12 running and the 1 waiting.",
    });
  });

  it("calls the waiting sessions sessions when one of them is not a Thread", () => {
    const some = buildMachine(
      { maxConcurrentSessions: 2 },
      { running: 2, waiting: 3, waitingThreads: 2 },
    );
    const one = buildMachine(
      { maxConcurrentSessions: 2 },
      { running: 2, waiting: 1, waitingThreads: 0 },
    );

    expect(findNeed(some)?.line).toBe("3 sessions wait for a slot");
    expect(findNeed(one)?.line).toBe("1 session waits for a slot");
  });

  it("leaves out the running part of the hint when nothing runs", () => {
    const machine = buildMachine(
      { maxConcurrentSessions: 1 },
      { running: 1, waiting: 1, waitingThreads: 1 },
    );
    const idle = buildMachine({ maxConcurrentSessions: 1 }, { running: 0, waiting: 1 });

    expect(findNeed(machine)).toMatchObject({
      allow: 2,
      allowHint: "Lets 2 sessions run here at once: the 1 running and the 1 waiting.",
    });
    // A free slot means the session starts by itself: no need, so no hint.
    expect(findNeed(idle)).toBeUndefined();
  });

  it("reports waiting sessions when only some of them would fit under the cap", () => {
    const machine = buildMachine(
      { maxConcurrentSessions: 12 },
      { running: 10, waiting: 3, waitingThreads: 3 },
    );

    expect(findNeed(machine)).toMatchObject({ kind: "waiting", allow: 13 });
  });

  it("does not report sessions that wait while a slot is free", () => {
    const machine = buildMachine({}, { running: 3, waiting: 2, waitingThreads: 2 });

    expect(findNeed(machine)).toBeUndefined();
  });

  it.each([
    ["offline", { connectivity: "offline" as const }],
    ["unreachable", { connectivity: "unreachable" as const }],
    ["draining", { lifecycle: "draining" as const }],
    ["short of disk", { metrics: { diskFreeBytes: 5 * GIB, availableMemoryBytes: 8 * GIB } }],
  ])("does not report waiting sessions while the machine is %s", (_name, overrides) => {
    // Raising the cap would start none of them, so Allow would do nothing.
    expect(findNeed(buildFullMachine(3, overrides))?.kind).not.toBe("waiting");
  });

  it("reports waiting sessions when the free disk equals the limit", () => {
    const machine = buildFullMachine(3, {
      metrics: { diskFreeBytes: 10 * GIB, availableMemoryBytes: 8 * GIB },
    });

    expect(findNeed(machine)?.kind).toBe("waiting");
  });

  it("does not report waiting sessions when the cap is not what holds them", () => {
    // Running plus waiting is exactly the cap: every one of them fits.
    const machine = buildMachine({ maxConcurrentSessions: 5 }, { running: 3, waiting: 2 });

    expect(findNeed(machine)).toBeUndefined();
  });

  it("reports a disk that is 85% full, with its percentage rounded down", () => {
    expect(findNeed(buildMachine(withDisk(130e9)))).toEqual({
      kind: "disk-nearly-full",
      hue: "you",
      line: "Disk 87% full",
    });
    expect(findNeed(buildMachine(withDisk(150e9)))?.line).toBe("Disk 85% full");
    expect(findNeed(buildMachine(withDisk(120.4e9)))?.line).toBe("Disk 87% full");
  });

  it("does not report a disk that is 84.6% full", () => {
    expect(findNeed(buildMachine(withDisk(154e9)))).toBeUndefined();
  });

  it("does not report a nearly full disk when the runner does not report its size", () => {
    const machine = buildMachine({
      facts: buildFacts(),
      metrics: { diskFreeBytes: 11e9, availableMemoryBytes: 8 * GIB },
    });

    expect(findNeed(machine)).toBeUndefined();
  });

  describe("when the disk is forecast to reach its limit", () => {
    it("reports it within 21 days, in days", () => {
      const machine = buildForecastMachine();

      expect(findNeed(machine, TIMEZONE, buildHistory(machine, 12))).toEqual({
        kind: "disk-reaches-limit",
        hue: "you",
        line: "Disk reaches its limit in about 12 days",
      });
      expect(findNeed(machine, TIMEZONE, buildHistory(machine, 21))?.line).toBe(
        "Disk reaches its limit in about 21 days",
      );
    });

    it("uses the singular for one day", () => {
      const machine = buildForecastMachine();

      expect(findNeed(machine, TIMEZONE, buildHistory(machine, 1))?.line).toBe(
        "Disk reaches its limit in about 1 day",
      );
    });

    it("reports nothing at 22 days", () => {
      const machine = buildForecastMachine();

      expect(findNeed(machine, TIMEZONE, buildHistory(machine, 22))).toBeUndefined();
    });
  });

  describe("when several needs apply, shows the most serious", () => {
    const waitingUnderFullDisk = { maxConcurrentSessions: 12 };
    const waitingCounts = { running: 12, waiting: 3, waitingThreads: 3 };
    const lowDisk = { metrics: { diskFreeBytes: 5 * GIB, availableMemoryBytes: 8 * GIB } };

    it("offline over a disk below its limit", () => {
      const machine = buildMachine({ connectivity: "offline", ...lowDisk }, waitingCounts);

      expect(findNeed(machine)?.kind).toBe("offline");
    });

    it("unreachable over a disk below its limit", () => {
      const machine = buildMachine({ connectivity: "unreachable", ...lowDisk }, waitingCounts);

      expect(findNeed(machine)?.kind).toBe("unreachable");
    });

    it("a disk below its limit over a disk that is 85% full", () => {
      // 5 GiB free of 1,000 GB is 99% full: both rows apply.
      const machine = buildMachine(
        { ...withDisk(5 * GIB), maxConcurrentSessions: 12 },
        waitingCounts,
      );

      expect(findNeed(machine)?.kind).toBe("disk-below-limit");
    });

    it("waiting sessions over a disk that is 85% full", () => {
      const machine = buildMachine({ ...waitingUnderFullDisk, ...withDisk(130e9) }, waitingCounts);

      expect(findNeed(machine)?.kind).toBe("waiting");
    });

    it("a disk that is 85% full over a disk forecast to reach its limit", () => {
      const machine = buildMachine(withDisk(130e9));

      expect(findNeed(machine, TIMEZONE, buildHistory(machine, 5))?.kind).toBe("disk-nearly-full");
    });
  });
});

describe("describeFleetPage lead", () => {
  const healthy = (running: number, overrides: Partial<Runner> = {}): TestMachine =>
    buildMachine({ maxConcurrentSessions: 100, ...overrides }, { running });
  const offline = (): TestMachine => buildMachine({ connectivity: "offline" });

  it("starts with 'Every machine is healthy.' when nothing needs the user", () => {
    const { lead } = describePage([healthy(2), healthy(3)]);

    expect(readText(lead.headline)).toBe("Every machine is healthy.");
    expect(lead.headline.every((part) => part.kind === "plain")).toBe(true);
  });

  it("builds the lead sentence from the online machines", () => {
    const { lead } = describePage([
      buildMachine({ maxConcurrentSessions: 15 }, { running: 15, waiting: 3, waitingThreads: 3 }),
      buildMachine({ maxConcurrentSessions: 30 }, { running: 29 }),
      buildMachine({ maxConcurrentSessions: 100 }, { running: 6 }),
      buildMachine({ maxConcurrentSessions: 100 }),
      offline(),
    ]);

    expect(readText(lead.headline)).toBe("Two machines need you.");
    expect(readText(lead.detail)).toBe(
      "50 sessions running on 4 machines, 3 waiting. Room for 195 more right now.",
    );
  });

  it("colours the count of machines and bolds the numbers", () => {
    const { lead } = describePage([offline(), healthy(1)]);

    expect(lead.headline).toEqual([
      { text: "One", kind: "count" },
      { text: " machine needs you.", kind: "plain" },
    ]);
    expect(lead.detail.filter((part) => part.kind === "number").map((part) => part.text)).toEqual([
      "1",
      "1",
      "99",
    ]);
  });

  it.each([
    [1, "One machine needs you."],
    [3, "Three machines need you."],
    [10, "Ten machines need you."],
    [11, "11 machines need you."],
  ])("counts %i machines that need the user", (count, sentence) => {
    const { lead } = describePage(Array.from({ length: count }, offline));

    expect(readText(lead.headline)).toBe(sentence);
  });

  it("uses singular words for one session on one machine", () => {
    const { lead } = describePage([healthy(1, { maxConcurrentSessions: 2 })]);

    expect(readText(lead.detail)).toBe(
      "1 session running on 1 machine. Room for 1 more right now.",
    );
  });

  it("leaves out the waiting part when no session waits", () => {
    expect(readText(describePage([healthy(5)]).lead.detail)).toBe(
      "5 sessions running on 1 machine. Room for 95 more right now.",
    );
  });

  it("says when there is no room", () => {
    const full = buildMachine({ maxConcurrentSessions: 2 }, { running: 2 });

    expect(readText(describePage([full]).lead.detail)).toBe(
      "2 sessions running on 1 machine. No room right now.",
    );
  });

  it("counts only the online machines in the totals", () => {
    const away = buildMachine({ connectivity: "unreachable" }, { running: 40, waiting: 9 });

    expect(readText(describePage([away, healthy(2)]).lead.detail)).toBe(
      "2 sessions running on 1 machine. Room for 98 more right now.",
    );
  });

  it("says so when no machine is online", () => {
    const { lead } = describePage([offline(), offline()]);

    expect(readText(lead.headline)).toBe("Two machines need you.");
    expect(readText(lead.detail)).toBe("No machine is online.");
  });

  it("says so when no machine has joined", () => {
    const { lead } = describePage([]);

    expect(readText(lead.headline)).toBe("No machine has joined yet.");
    expect(lead.detail).toEqual([]);
  });
});

describe("describeFleetPage machinesSection", () => {
  it("counts the machines that need the user, or else all machines", () => {
    const calm = buildMachine();

    expect(
      describePage([calm, buildMachine({ connectivity: "offline" }), buildFullMachine(2)]),
    ).toMatchObject({ machinesSection: { text: "2 need you", isYou: true } });
    expect(describePage([calm, buildMachine()]).machinesSection).toEqual({
      text: "2",
      isYou: false,
    });
  });
});

describe("describeFleetPage isEmpty", () => {
  const local = buildMachine();
  const remote = buildMachine();
  const remoteOffline = buildMachine({ connectivity: "offline" });

  it.each([
    ["no machine", [], local.runner.id, true],
    ["only the controller's own runner", [local], local.runner.id, true],
    ["a remote machine that is offline", [local, remoteOffline], local.runner.id, true],
    ["a remote machine that is online", [local, remote], local.runner.id, false],
    ["an online machine while the controller has no runner of its own", [remote], null, false],
  ] as const)("with %s the fleet is empty: %s", (_, machines, localRunnerId, expected) => {
    expect(describePage(machines, localRunnerId).isEmpty).toBe(expected);
  });
});

describe("MachineSummary roomText", () => {
  it("counts the room under the cap", () => {
    expect(summarize({ maxConcurrentSessions: 16 }, { running: 12 }).roomText).toBe("Room for 4");
  });

  it("is Full, never below no room, when more sessions run than the cap allows", () => {
    expect(summarize({ maxConcurrentSessions: 4 }, { running: 6 }).roomText).toBe("Full");
  });

  it("says Full when every slot is taken", () => {
    expect(summarize({ maxConcurrentSessions: 16 }, { running: 16 }).roomText).toBe("Full");
  });

  it("is not reduced by a reserved runner, labels, a runner that has not reported its disk or memory", () => {
    const texts = [
      summarize({ reserved: true, labels: ["gpu"] }),
      summarize({ metrics: null }),
      summarize({ metrics: { diskFreeBytes: 20 * GIB, availableMemoryBytes: 0 } }),
    ].map((machine) => machine.roomText);

    expect(texts).toEqual(["Room for 16", "Room for 16", "Room for 16"]);
  });

  it("counts a free disk equal to the limit as enough", () => {
    const metrics = { diskFreeBytes: 10 * GIB, availableMemoryBytes: 8 * GIB };

    expect(summarize({ metrics }).roomText).toBe("Room for 16");
  });

  it("is null for a disk below its limit, because the need line says so", () => {
    const metrics = { diskFreeBytes: 5 * GIB, availableMemoryBytes: 8 * GIB };

    expect(summarize({ metrics }).roomText).toBeNull();
  });

  it("is null for a machine told to take no new work, because its status says so", () => {
    expect(summarize({ lifecycle: "draining" }).roomText).toBeNull();
  });

  it.each(["offline", "unreachable"] as const)("is null while the machine is %s", (state) => {
    expect(summarize({ connectivity: state }).roomText).toBeNull();
  });
});

describe("MachineSummary drawing", () => {
  const drawing = (cap: number, running: number, waiting = 0) =>
    summarize({ maxConcurrentSessions: cap }, { running, waiting }).drawing;

  it("draws one block per slot at a cap of 16", () => {
    expect(drawing(16, 12, 3)).toMatchObject({
      shape: "blocks",
      cap: 16,
      running: 12,
      free: 4,
      waiting: 3,
      waitingBlocks: 3,
    });
  });

  it("draws one bar above a cap of 16", () => {
    expect(drawing(17, 12, 3)).toMatchObject({
      shape: "bar",
      cap: 17,
      running: 12,
      free: 5,
      waiting: 3,
      waitingBlocks: 0,
    });
  });

  it("draws blocks for 16 sessions running past a lower cap, and a bar for 17", () => {
    expect(drawing(4, 16)).toMatchObject({ shape: "blocks", running: 16, free: 0 });
    expect(drawing(4, 17)).toMatchObject({ shape: "bar", running: 17, free: 0 });
  });

  it("draws a bar when the cap was lowered under many running sessions", () => {
    expect(drawing(4, 100)).toMatchObject({ shape: "bar", cap: 4, running: 100, free: 0 });
  });

  it("has no free slot when more sessions run than the cap allows", () => {
    expect(drawing(4, 6)).toMatchObject({ cap: 4, running: 6, free: 0 });
  });

  it("draws at most 16 waiting blocks, and keeps the full count of waiting sessions", () => {
    expect(drawing(16, 16, 16)).toMatchObject({ waiting: 16, waitingBlocks: 16 });
    expect(drawing(16, 16, 40)).toMatchObject({ waiting: 40, waitingBlocks: 16 });
  });

  it("draws no waiting blocks in a bar, which stretches over all of the waiting sessions", () => {
    expect(drawing(17, 17, 40)).toMatchObject({ waiting: 40, waitingBlocks: 0 });
  });

  it("words the sessions running against the cap, and the sessions waiting", () => {
    expect(drawing(16, 12, 5)).toMatchObject({
      isAway: false,
      runningText: "12",
      capText: " of 16",
      waitingText: "5 waiting",
    });
  });

  it("has no waiting text while no session waits", () => {
    expect(drawing(16, 12).waitingText).toBeNull();
  });

  describe("of a machine that is away", () => {
    const awayDrawing = (
      cap: number,
      running: number,
      waiting: number,
      connectivity: "offline" | "unreachable" = "offline",
    ) => summarize({ maxConcurrentSessions: cap, connectivity }, { running, waiting }).drawing;

    it.each(["offline", "unreachable"] as const)(
      "counts a %s machine as running none, with every slot free and a dash for its running text",
      (connectivity) => {
        expect(awayDrawing(16, 12, 5, connectivity)).toMatchObject({
          isAway: true,
          running: 0,
          free: 16,
          runningText: "–",
          capText: " of 16",
        });
      },
    );

    it("keeps the sessions that wait for it, because the controller still knows them", () => {
      expect(awayDrawing(16, 12, 5)).toMatchObject({
        waiting: 5,
        waitingBlocks: 5,
        waitingText: "5 waiting",
      });
    });

    it("draws blocks for a cap of 16, however many sessions it last ran", () => {
      expect(awayDrawing(4, 100, 0)).toMatchObject({ shape: "blocks", running: 0, free: 4 });
    });
  });
});

describe("MachineSummary kind", () => {
  it.each([
    ["linux", 8 * GIB, "server"],
    ["linux", 256 * GIB, "server"],
    ["darwin", 16 * GIB, "laptop"],
    ["darwin", 64 * GIB, "desktop"],
    ["win32", 128 * GIB, "desktop"],
    ["win32", 32 * GIB, "laptop"],
    ["freebsd", 128 * GIB, "laptop"],
  ])("takes %s with %d bytes of RAM for a %s", (os, totalMemoryBytes, kind) => {
    expect(summarize({ facts: buildFacts({ os, totalMemoryBytes }) }).kind).toBe(kind);
  });

  it("takes a machine that has not reported its facts for a laptop", () => {
    expect(summarize({ facts: null }).kind).toBe("laptop");
  });
});

const NOT_REPORTED = { value: "–", unit: "", freeAmount: "", share: null, level: "normal" };

describe("MachineSummary disk", () => {
  // The disk limit is 10 GiB; levels are checked apart, so only the size is read here.
  const readDisk = (diskFreeBytes: number) =>
    summarize({ metrics: { diskFreeBytes, availableMemoryBytes: 8 * GIB } }).disk;

  it.each([
    [10 * GIB, "10.7", "GB"],
    [42.14e9, "42.1", "GB"],
    [99.94e9, "99.9", "GB"],
    [99.96e9, "100", "GB"],
    [100e9, "100", "GB"],
    [245.4e9, "245", "GB"],
    [999.4e9, "999", "GB"],
    [1000e9, "1,000", "GB"],
    [2 ** 40, "1,100", "GB"],
    [2000 * GIB, "2,147", "GB"],
    [420e6, "420", "MB"],
    [999.6e6, "1.0", "GB"],
    [1e9, "1.0", "GB"],
    [0, "0", "MB"],
  ])("shows %d free bytes as %s %s", (bytes, amount, unit) => {
    expect(readDisk(bytes)).toMatchObject({ freeAmount: `${amount} ${unit}` });
  });

  it("shows the free space and an empty meter until the runner reports its disk total", () => {
    expect(readDisk(42.14e9)).toEqual({
      value: "42.1",
      unit: " GB free",
      freeAmount: "42.1 GB",
      share: null,
      level: "normal",
    });
  });

  it("is failing while the free space is below the limit, normal otherwise", () => {
    expect(readDisk(5 * GIB).level).toBe("fail");
    expect(readDisk(10 * GIB).level).toBe("normal");
  });

  describe("with the disk's total size", () => {
    const readFullDisk = (diskFreeBytes: number) => summarize(withDisk(diskFreeBytes)).disk;

    it.each([
      [500e9, 0.5, 50, "normal"],
      [154e9, 0.846, 84, "normal"],
      [150e9, 0.85, 85, "you"],
      [130e9, 0.87, 87, "you"],
      [290e9, 0.71, 71, "normal"],
      [11e9, 0.989, 98, "you"],
    ] as const)(
      "reads %d free bytes as %d full: %d percent, level %s",
      (free, share, percent, level) => {
        expect(readFullDisk(free)).toMatchObject({
          value: String(percent),
          unit: "%",
          share,
          level,
        });
      },
    );

    it("names the free space beside the percentage", () => {
      expect(readFullDisk(130e9)).toMatchObject({ freeAmount: "130 GB" });
    });

    it("is failing while the free space is below the limit, whatever the percentage", () => {
      expect(readFullDisk(5 * GIB)).toMatchObject({ value: "99", level: "fail" });
      expect(readFullDisk(10 * GIB)).toMatchObject({ level: "you" });
    });

    it("stays between 0 and 100 percent when more is free than the disk holds", () => {
      expect(readFullDisk(2 * DISK_TOTAL)).toMatchObject({ share: 0, value: "0" });
    });
  });

  it("fails below the limit even when the runner does not report the disk's total", () => {
    expect(readDisk(5 * GIB)).toMatchObject({ level: "fail", share: null });
  });

  it("is not reported until the runner reports its disk", () => {
    expect(summarize({ metrics: null }).disk).toEqual(NOT_REPORTED);
  });
});

describe("MachineSummary diskCaption", () => {
  const readCaption = (daysToLimit: number | null, runnerOverrides: Partial<Runner> = {}) => {
    const machine = buildMachine({ ...withDisk(250e9), ...runnerOverrides });
    const history = daysToLimit === null ? undefined : buildHistory(machine, daysToLimit);
    return describePage([machine], null, TIMEZONE, history).machines[0]!.diskCaption;
  };

  it("names the free space while there is no forecast", () => {
    expect(readCaption(null)).toEqual({ text: "250 GB free", isForecast: false });
  });

  it("words the days until the limit while the forecast shows", () => {
    expect(readCaption(12)).toEqual({ text: "Limit in 12 days", isForecast: true });
    expect(readCaption(1)).toEqual({ text: "Limit in 1 day", isForecast: true });
  });

  it("shows the forecast up to 60 days, beyond the 21 days that make the machine need the user", () => {
    expect(readCaption(22)).toEqual({ text: "Limit in 22 days", isForecast: true });
    expect(readCaption(60)).toEqual({ text: "Limit in 60 days", isForecast: true });
    expect(readCaption(62)).toEqual({ text: "250 GB free", isForecast: false });
  });

  it("shows the forecast of a machine that is away", () => {
    expect(readCaption(12, { connectivity: "offline" }).text).toBe("Limit in 12 days");
  });
});

describe("MachineSummary memory", () => {
  const readMemory = (totalGib: number, availableGib: number) =>
    summarize({
      facts: buildFacts({ totalMemoryBytes: totalGib * GIB }),
      metrics: { diskFreeBytes: 20 * GIB, availableMemoryBytes: availableGib * GIB },
    }).memory;

  it.each([
    [100, 50, 50, "normal"],
    [100, 21, 79, "normal"],
    [100, 20, 80, "you"],
    [100, 9, 91, "you"],
    [100, 8, 92, "fail"],
    [100, 0, 100, "fail"],
  ])(
    "reads %d total and %d available as %d percent in use, level %s",
    (total, available, percent, level) => {
      expect(readMemory(total, available)).toMatchObject({
        value: String(percent),
        unit: "%",
        share: percent / 100,
        level,
      });
    },
  );

  it("shows the percentage rounded down and colours it on the rounded-down percent", () => {
    // 79.9% in use is "79" and normal, never a normal-coloured "80".
    expect(readMemory(1000, 201)).toMatchObject({ value: "79", level: "normal" });
    expect(readMemory(1000, 200)).toMatchObject({ value: "80", level: "you" });
    expect(readMemory(1000, 81)).toMatchObject({ value: "91", level: "you" });
    expect(readMemory(1000, 79)).toMatchObject({ value: "92", level: "fail" });
  });

  it("names the free memory in binary gigabytes, whole from 100", () => {
    expect(readMemory(64, 17.6).freeAmount).toBe("17.6 GB");
    expect(readMemory(256, 120.4).freeAmount).toBe("120 GB");
  });

  it("stays between 0 and 100 percent when the runner reports more available than total", () => {
    expect(readMemory(100, 120)).toMatchObject({ value: "0", share: 0, level: "normal" });
  });

  it("is not reported until the runner reports its total memory", () => {
    expect(summarize({ facts: null }).memory).toEqual(NOT_REPORTED);
  });

  it("is not reported until the runner reports its available memory", () => {
    expect(summarize({ facts: buildFacts(), metrics: null }).memory).toEqual(NOT_REPORTED);
  });
});

describe("MachineSummary status", () => {
  it("is Online for a machine that is simply online", () => {
    expect(summarize().status).toEqual({ tone: "online", label: "Online" });
  });

  it("says Offline for an offline machine, also while draining", () => {
    expect(summarize({ connectivity: "offline", lifecycle: "draining" }).status).toEqual({
      tone: "offline",
      label: "Offline",
    });
  });

  it("says when an unreachable machine was last heard from", () => {
    expect(summarize({ connectivity: "unreachable" }).status).toEqual({
      tone: "offline",
      label: "Not heard from since 09:12",
    });
  });

  it("says Unreachable for an unreachable machine that was never seen", () => {
    expect(summarize({ connectivity: "unreachable", lastSeenAt: null }).status.label).toBe(
      "Unreachable",
    );
  });

  it("says an online machine takes no new work while draining", () => {
    expect(summarize({ lifecycle: "draining" }).status).toEqual({
      tone: "draining",
      label: "Takes no new work",
    });
  });
});

describe("MachineSummary", () => {
  it("gathers what a card draws for a healthy machine", () => {
    const machine = summarize(
      {
        facts: buildFacts({ totalMemoryBytes: 16 * GIB }),
        metrics: { diskFreeBytes: 42.14e9, availableMemoryBytes: 4 * GIB },
      },
      { running: 12 },
    );

    expect(machine).toMatchObject({
      status: { tone: "online", label: "Online" },
      isAway: false,
      roomText: "Room for 4",
      need: undefined,
      disk: { value: "42.1", unit: " GB free", level: "normal", share: null },
      memory: { value: "75", unit: "%", share: 0.75, level: "normal" },
    });
  });

  it("takes the first need, with a disk below its limit failing", () => {
    const machine = summarize({
      metrics: { diskFreeBytes: 5 * GIB, availableMemoryBytes: 8 * GIB },
    });

    expect(machine.disk.level).toBe("fail");
    expect(machine.need?.kind).toBe("disk-below-limit");
  });

  it("has no disk, memory or room for an offline machine that never reported", () => {
    expect(summarize({ connectivity: "offline", metrics: null })).toMatchObject({
      isAway: true,
      roomText: null,
      disk: NOT_REPORTED,
      memory: NOT_REPORTED,
      need: { kind: "offline" },
    });
  });
});
