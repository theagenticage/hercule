import { describe, expect, it } from "vitest";
import type { Runner, RunnerFacts, Session, SessionKind, SessionStatus } from "@hercule/contract";
import {
  countRunnerSessions,
  describeFleetPage,
  findMachineNeeds,
  type FleetLead,
  type MachineSummary,
  type SessionCountsByRunner,
} from "./fleet";

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

const describePage = (
  machines: readonly TestMachine[],
  localRunnerId: string | null = null,
  timezone = TIMEZONE,
) =>
  describeFleetPage(
    machines.map(({ runner }) => runner),
    Object.fromEntries(machines.map(({ runner, counts }) => [runner.id, counts])),
    localRunnerId,
    timezone,
    TODAY,
  );

/** Returns what the Fleet page draws for one machine. */
const summarize = (
  runnerOverrides: Partial<Runner> = {},
  counts: Partial<Counts> = {},
): MachineSummary => describePage([buildMachine(runnerOverrides, counts)]).machines[0]!;

const findNeeds = ({ runner, counts }: TestMachine, timezone = TIMEZONE) =>
  findMachineNeeds(runner, { [runner.id]: counts }, timezone, TODAY);

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

    const { machines } = describeFleetPage([second, retired, first], {}, null, TIMEZONE, TODAY);

    expect(machines.map((machine) => machine.name)).toEqual(["first", "second"]);
  });

  it("gives each machine the counts of its runner, and none to a runner without sessions", () => {
    const atlas = buildRunner({ id: "01a06d02-0001-7000-8000-000000000001" });
    const moss = buildRunner({ id: "01a06d02-0002-7000-8000-000000000001" });
    const counts = countRunnerSessions([
      buildSession(atlas.id, "busy"),
      buildSession(atlas.id, "queued"),
    ]);

    const { machines } = describeFleetPage([atlas, moss], counts, null, TIMEZONE, TODAY);

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

    const page = describeFleetPage([atlas], counts, null, TIMEZONE, TODAY);

    expect(page.machines).toEqual(describeFleetPage([atlas], {}, null, TIMEZONE, TODAY).machines);
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

describe("findMachineNeeds", () => {
  it("is empty for a healthy machine", () => {
    expect(findNeeds(buildMachine())).toEqual([]);
  });

  it("says when an offline machine was last seen", () => {
    const [need] = findNeeds(buildMachine({ connectivity: "offline" }));

    expect(need).toEqual({ kind: "offline", hue: "fail", line: "Offline since 09:12" });
  });

  it("names the day when the machine was last seen on another day", () => {
    const machine = buildMachine({
      connectivity: "offline",
      lastSeenAt: "2026-10-30T09:12:00.000Z",
    });

    expect(findNeeds(machine)[0]?.line).toBe("Offline since Fri 09:12");
  });

  it("reads the time in the user's timezone", () => {
    expect(findNeeds(buildMachine({ connectivity: "offline" }), "Europe/Amsterdam")[0]?.line).toBe(
      "Offline since 10:12",
    );
  });

  it("words a time relative to the date of today, whatever the time of day", () => {
    const { runner } = buildMachine({ connectivity: "offline" });
    const startOfDay = new Date("2026-11-02T00:00:00.000Z");

    expect(findMachineNeeds(runner, {}, TIMEZONE, startOfDay)[0]?.line).toBe("Offline since 09:12");
  });

  it("leaves out the time of a machine that was never seen", () => {
    const machine = buildMachine({ connectivity: "offline", lastSeenAt: null });

    expect(findNeeds(machine)[0]?.line).toBe("Offline");
  });

  it("says when an unreachable machine was last heard from", () => {
    const [need] = findNeeds(buildMachine({ connectivity: "unreachable" }));

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

    expect(findNeeds(machine)).toEqual([
      {
        kind: "disk-below-limit",
        hue: "fail",
        line: "Disk below its limit. It takes no new sessions.",
      },
    ]);
  });

  it("reports waiting Threads with the cap that lets them start", () => {
    expect(findNeeds(buildFullMachine(3))).toEqual([
      {
        kind: "waiting",
        hue: "you",
        line: "3 threads wait for a slot",
        allow: 15,
        allowHint: "Lets 15 sessions run here at once: the 12 running and the 3 waiting.",
      },
    ]);
  });

  it("uses singular words for one waiting Thread", () => {
    const [need] = findNeeds(buildFullMachine(1));

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

    expect(findNeeds(some)[0]?.line).toBe("3 sessions wait for a slot");
    expect(findNeeds(one)[0]?.line).toBe("1 session waits for a slot");
  });

  it("leaves out the running part of the hint when nothing runs", () => {
    const machine = buildMachine(
      { maxConcurrentSessions: 1 },
      { running: 1, waiting: 1, waitingThreads: 1 },
    );
    const idle = buildMachine({ maxConcurrentSessions: 1 }, { running: 0, waiting: 1 });

    expect(findNeeds(machine)[0]).toMatchObject({
      allow: 2,
      allowHint: "Lets 2 sessions run here at once: the 1 running and the 1 waiting.",
    });
    // A free slot means the session starts by itself: no need, so no hint.
    expect(findNeeds(idle)).toEqual([]);
  });

  it("reports waiting sessions when only some of them would fit under the cap", () => {
    const machine = buildMachine(
      { maxConcurrentSessions: 12 },
      { running: 10, waiting: 3, waitingThreads: 3 },
    );

    expect(findNeeds(machine)[0]).toMatchObject({ kind: "waiting", allow: 13 });
  });

  it("does not report sessions that wait while a slot is free", () => {
    const machine = buildMachine({}, { running: 3, waiting: 2, waitingThreads: 2 });

    expect(findNeeds(machine)).toEqual([]);
  });

  it.each([
    ["offline", { connectivity: "offline" as const }],
    ["unreachable", { connectivity: "unreachable" as const }],
    ["draining", { lifecycle: "draining" as const }],
    ["short of disk", { metrics: { diskFreeBytes: 5 * GIB, availableMemoryBytes: 8 * GIB } }],
  ])("does not report waiting sessions while the machine is %s", (_name, overrides) => {
    // Raising the cap would start none of them, so Allow would do nothing.
    const kinds = findNeeds(buildFullMachine(3, overrides)).map((need) => need.kind);

    expect(kinds).not.toContain("waiting");
  });

  it("reports waiting sessions when the free disk equals the limit", () => {
    const machine = buildFullMachine(3, {
      metrics: { diskFreeBytes: 10 * GIB, availableMemoryBytes: 8 * GIB },
    });

    expect(findNeeds(machine)[0]?.kind).toBe("waiting");
  });

  it("does not report waiting sessions when the cap is not what holds them", () => {
    // Running plus waiting is exactly the cap: every one of them fits.
    const machine = buildMachine({ maxConcurrentSessions: 5 }, { running: 3, waiting: 2 });

    expect(findNeeds(machine)).toEqual([]);
  });

  it("lists every need that applies, the most serious first", () => {
    const machine = buildMachine(
      {
        connectivity: "unreachable",
        metrics: { diskFreeBytes: 5 * GIB, availableMemoryBytes: 8 * GIB },
      },
      { running: 12, waiting: 3 },
    );

    expect(findNeeds(machine).map((need) => need.kind)).toEqual([
      "unreachable",
      "disk-below-limit",
    ]);
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
    expect(drawing(16, 12, 3)).toEqual({
      shape: "blocks",
      cap: 16,
      running: 12,
      free: 4,
      waiting: 3,
      waitingBlocks: 3,
    });
  });

  it("draws one bar above a cap of 16", () => {
    expect(drawing(17, 12, 3)).toEqual({
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
    expect(readDisk(bytes)).toMatchObject({ amount, unit });
  });

  it("has no share until the runner reports its disk total, so the gauge draws empty", () => {
    expect(readDisk(20 * GIB)?.share).toBeNull();
  });

  it("is failing while the free space is below the limit, normal otherwise", () => {
    expect(readDisk(5 * GIB)?.level).toBe("fail");
    expect(readDisk(10 * GIB)?.level).toBe("normal");
  });

  it("is null until the runner reports its disk", () => {
    expect(summarize({ metrics: null }).disk).toBeNull();
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
      expect(readMemory(total, available)).toEqual({ percent, share: percent / 100, level });
    },
  );

  it("stays between 0 and 100 percent when the runner reports more available than total", () => {
    expect(readMemory(100, 120)).toEqual({ percent: 0, share: 0, level: "normal" });
  });

  it("is null until the runner reports its total memory", () => {
    expect(summarize({ facts: null }).memory).toBeNull();
  });

  it("is null until the runner reports its available memory", () => {
    expect(summarize({ facts: buildFacts(), metrics: null }).memory).toBeNull();
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
      disk: { amount: "42.1", unit: "GB", level: "normal", share: null },
      memory: { percent: 75, share: 0.75, level: "normal" },
    });
  });

  it("takes the first need, with a disk below its limit failing", () => {
    const machine = summarize({
      metrics: { diskFreeBytes: 5 * GIB, availableMemoryBytes: 8 * GIB },
    });

    expect(machine.disk?.level).toBe("fail");
    expect(machine.need?.kind).toBe("disk-below-limit");
  });

  it("has no disk, memory or room for an offline machine that never reported", () => {
    expect(summarize({ connectivity: "offline", metrics: null })).toMatchObject({
      isAway: true,
      roomText: null,
      disk: null,
      memory: null,
      need: { kind: "offline" },
    });
  });
});
