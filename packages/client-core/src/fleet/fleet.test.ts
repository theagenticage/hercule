import { describe, expect, it } from "vitest";
import type { Runner, RunnerFacts, Session, SessionKind, SessionStatus } from "@hercule/contract";
import {
  buildFleetMachine,
  buildFleetMachines,
  buildSessionsDrawing,
  countRunnerSessions,
  decideMachineKind,
  describeFleet,
  describeMachinesSection,
  describeMachineStatus,
  describeRoom,
  findMachineNeeds,
  isFleetEmpty,
  summarizeMachine,
  type FleetLead,
  type FleetMachine,
} from "./fleet";

const GIB = 1024 ** 3;
const TIMEZONE = "UTC";
const NOW = new Date("2026-11-02T14:00:00.000Z");
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
  watermark: { diskFreeBytes: 20 * GIB, availableMemoryBytes: 8 * GIB },
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

const buildMachine = (
  runnerOverrides: Partial<Runner> = {},
  counts: Partial<Omit<FleetMachine, "runner">> = {},
): FleetMachine => ({
  runner: buildRunner(runnerOverrides),
  running: 0,
  waiting: 0,
  waitingThreads: 0,
  openThreads: 0,
  ...counts,
});

/** Returns a machine whose slots are all taken and with threads waiting. */
const buildFullMachine = (waiting: number, runnerOverrides: Partial<Runner> = {}): FleetMachine =>
  buildMachine(
    { maxConcurrentSessions: 12, ...runnerOverrides },
    { running: 12, waiting, waitingThreads: waiting },
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

describe("buildFleetMachines", () => {
  it("drops retired runners and orders the rest by when they joined", () => {
    const first = buildRunner({ id: "01a06d02-0001-7000-8000-000000000001", name: "first" });
    const second = buildRunner({ id: "01a06d02-0002-7000-8000-000000000001", name: "second" });
    const retired = buildRunner({
      id: "01a06d02-0003-7000-8000-000000000001",
      lifecycle: "retired",
    });

    const machines = buildFleetMachines([second, retired, first], {});

    expect(machines.map((machine) => machine.runner.name)).toEqual(["first", "second"]);
  });

  it("gives each machine the counts of its runner, and none to a runner without sessions", () => {
    const atlas = buildRunner({ id: "01a06d02-0001-7000-8000-000000000001" });
    const moss = buildRunner({ id: "01a06d02-0002-7000-8000-000000000001" });
    const counts = countRunnerSessions([
      buildSession(atlas.id, "busy"),
      buildSession(atlas.id, "queued"),
    ]);

    const [first, second] = buildFleetMachines([atlas, moss], counts);

    expect(first).toMatchObject({ running: 1, waiting: 1, waitingThreads: 1, openThreads: 2 });
    expect(second).toMatchObject({ running: 0, waiting: 0, waitingThreads: 0, openThreads: 0 });
  });

  it("ignores the counts of a runner that is not in the list", () => {
    const atlas = buildRunner();
    const counts = countRunnerSessions([
      buildSession("01a06d02-9999-7000-8000-000000000001", "busy"),
    ]);

    expect(buildFleetMachines([atlas], counts)).toEqual([buildFleetMachine(atlas, {})]);
  });
});

describe("findMachineNeeds", () => {
  it("is empty for a healthy machine", () => {
    expect(findMachineNeeds(buildMachine(), TIMEZONE, NOW)).toEqual([]);
  });

  it("says when an offline machine was last seen", () => {
    const [need] = findMachineNeeds(buildMachine({ connectivity: "offline" }), TIMEZONE, NOW);

    expect(need).toEqual({ kind: "offline", hue: "fail", line: "Offline since 09:12" });
  });

  it("names the day when the machine was last seen on another day", () => {
    const machine = buildMachine({
      connectivity: "offline",
      lastSeenAt: "2026-10-30T09:12:00.000Z",
    });

    expect(findMachineNeeds(machine, TIMEZONE, NOW)[0]?.line).toBe("Offline since Fri 09:12");
  });

  it("reads the time in the user's timezone", () => {
    const machine = buildMachine({ connectivity: "offline" });

    expect(findMachineNeeds(machine, "Europe/Amsterdam", NOW)[0]?.line).toBe("Offline since 10:12");
  });

  it("leaves out the time of a machine that was never seen", () => {
    const machine = buildMachine({ connectivity: "offline", lastSeenAt: null });

    expect(findMachineNeeds(machine, TIMEZONE, NOW)[0]?.line).toBe("Offline");
  });

  it("says when an unreachable machine was last heard from", () => {
    const [need] = findMachineNeeds(buildMachine({ connectivity: "unreachable" }), TIMEZONE, NOW);

    expect(need).toEqual({
      kind: "unreachable",
      hue: "fail",
      line: "Not heard from since 09:12",
    });
  });

  it("reports a disk below its limit", () => {
    const machine = buildMachine({
      watermark: { diskFreeBytes: 5 * GIB, availableMemoryBytes: 8 * GIB },
    });

    expect(findMachineNeeds(machine, TIMEZONE, NOW)).toEqual([
      {
        kind: "disk-below-limit",
        hue: "fail",
        line: "Disk below its limit. It takes no new sessions.",
      },
    ]);
  });

  it("reports waiting Threads with the cap that lets them start", () => {
    expect(findMachineNeeds(buildFullMachine(3), TIMEZONE, NOW)).toEqual([
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
    const [need] = findMachineNeeds(buildFullMachine(1), TIMEZONE, NOW);

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

    expect(findMachineNeeds(some, TIMEZONE, NOW)[0]?.line).toBe("3 sessions wait for a slot");
    expect(findMachineNeeds(one, TIMEZONE, NOW)[0]?.line).toBe("1 session waits for a slot");
  });

  it("leaves out the running part of the hint when nothing runs", () => {
    const machine = buildMachine(
      { maxConcurrentSessions: 1 },
      { running: 1, waiting: 1, waitingThreads: 1 },
    );
    const idle = buildMachine({ maxConcurrentSessions: 1 }, { running: 0, waiting: 1 });

    expect(findMachineNeeds(machine, TIMEZONE, NOW)[0]).toMatchObject({
      allow: 2,
      allowHint: "Lets 2 sessions run here at once: the 1 running and the 1 waiting.",
    });
    // A free slot means the session starts by itself: no need, so no hint.
    expect(findMachineNeeds(idle, TIMEZONE, NOW)).toEqual([]);
  });

  it("reports waiting sessions when only some of them would fit under the cap", () => {
    const machine = buildMachine(
      { maxConcurrentSessions: 12 },
      { running: 10, waiting: 3, waitingThreads: 3 },
    );

    expect(findMachineNeeds(machine, TIMEZONE, NOW)[0]).toMatchObject({
      kind: "waiting",
      allow: 13,
    });
  });

  it("does not report sessions that wait while a slot is free", () => {
    const machine = buildMachine({}, { running: 3, waiting: 2, waitingThreads: 2 });

    expect(findMachineNeeds(machine, TIMEZONE, NOW)).toEqual([]);
  });

  it.each([
    ["offline", { connectivity: "offline" as const }],
    ["unreachable", { connectivity: "unreachable" as const }],
    ["draining", { lifecycle: "draining" as const }],
    ["short of disk", { watermark: { diskFreeBytes: 5 * GIB, availableMemoryBytes: 8 * GIB } }],
  ])("does not report waiting sessions while the machine is %s", (_name, overrides) => {
    // Raising the cap would start none of them, so Allow would do nothing.
    const kinds = findMachineNeeds(buildFullMachine(3, overrides), TIMEZONE, NOW).map(
      (need) => need.kind,
    );

    expect(kinds).not.toContain("waiting");
  });

  it("reports waiting sessions when the free disk equals the limit", () => {
    const machine = buildFullMachine(3, {
      watermark: { diskFreeBytes: 10 * GIB, availableMemoryBytes: 8 * GIB },
    });

    expect(findMachineNeeds(machine, TIMEZONE, NOW)[0]?.kind).toBe("waiting");
  });

  it("does not report waiting sessions when the cap is not what holds them", () => {
    // Running plus waiting is exactly the cap: every one of them fits.
    const machine = buildMachine({ maxConcurrentSessions: 5 }, { running: 3, waiting: 2 });

    expect(findMachineNeeds(machine, TIMEZONE, NOW)).toEqual([]);
  });

  it("lists every need that applies, the most serious first", () => {
    const machine = buildMachine(
      {
        connectivity: "unreachable",
        watermark: { diskFreeBytes: 5 * GIB, availableMemoryBytes: 8 * GIB },
      },
      { running: 12, waiting: 3 },
    );

    expect(findMachineNeeds(machine, TIMEZONE, NOW).map((need) => need.kind)).toEqual([
      "unreachable",
      "disk-below-limit",
    ]);
  });
});

describe("describeFleet", () => {
  const healthy = (running: number, overrides: Partial<Runner> = {}): FleetMachine =>
    buildMachine({ maxConcurrentSessions: 100, ...overrides }, { running });
  const offline = (): FleetMachine => buildMachine({ connectivity: "offline" });

  it("starts with 'Every machine is healthy.' when nothing needs the user", () => {
    const lead = describeFleet([healthy(2), healthy(3)]);

    expect(readText(lead.headline)).toBe("Every machine is healthy.");
    expect(lead.headline.every((part) => part.kind === "plain")).toBe(true);
  });

  it("builds the lead sentence from the online machines", () => {
    const machines = [
      buildMachine({ maxConcurrentSessions: 15 }, { running: 15, waiting: 3, waitingThreads: 3 }),
      buildMachine({ maxConcurrentSessions: 30 }, { running: 29 }),
      buildMachine({ maxConcurrentSessions: 100 }, { running: 6 }),
      buildMachine({ maxConcurrentSessions: 100 }),
      offline(),
    ];
    const lead = describeFleet(machines);

    expect(readText(lead.headline)).toBe("Two machines need you.");
    expect(readText(lead.detail)).toBe(
      "50 sessions running on 4 machines, 3 waiting. Room for 195 more right now.",
    );
  });

  it("colours the count of machines and bolds the numbers", () => {
    const lead = describeFleet([offline(), healthy(1)]);

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
    const lead = describeFleet(Array.from({ length: count }, offline));

    expect(readText(lead.headline)).toBe(sentence);
  });

  it("uses singular words for one session on one machine", () => {
    const lead = describeFleet([healthy(1, { maxConcurrentSessions: 2 })]);

    expect(readText(lead.detail)).toBe(
      "1 session running on 1 machine. Room for 1 more right now.",
    );
  });

  it("leaves out the waiting part when no session waits", () => {
    expect(readText(describeFleet([healthy(5)]).detail)).toBe(
      "5 sessions running on 1 machine. Room for 95 more right now.",
    );
  });

  it("says when there is no room", () => {
    const full = buildMachine({ maxConcurrentSessions: 2 }, { running: 2 });

    expect(readText(describeFleet([full]).detail)).toBe(
      "2 sessions running on 1 machine. No room right now.",
    );
  });

  it("counts only the online machines in the totals", () => {
    const away = buildMachine({ connectivity: "unreachable" }, { running: 40, waiting: 9 });

    expect(readText(describeFleet([away, healthy(2)]).detail)).toBe(
      "2 sessions running on 1 machine. Room for 98 more right now.",
    );
  });

  it("says so when no machine is online", () => {
    const lead = describeFleet([offline(), offline()]);

    expect(readText(lead.headline)).toBe("Two machines need you.");
    expect(readText(lead.detail)).toBe("No machine is online.");
  });

  it("says so when no machine has joined", () => {
    expect(readText(describeFleet([]).headline)).toBe("No machine has joined yet.");
  });
});

describe("describeRoom", () => {
  const readLine = (machine: FleetMachine): string | undefined =>
    describeRoom(machine)
      .line?.map((part) => part.text)
      .join("");

  it("counts the room under the cap, with the number apart from the words", () => {
    const room = describeRoom(buildMachine({ maxConcurrentSessions: 16 }, { running: 12 }));

    expect(room.short).toBe("Room for 4");
    expect(room.line).toEqual([
      { text: "Room for ", kind: "plain" },
      { text: "4", kind: "number" },
      { text: " more, under its cap of 16", kind: "plain" },
    ]);
  });

  it("is never below no room when more sessions run than the cap allows", () => {
    const machine = buildMachine({ maxConcurrentSessions: 4 }, { running: 6 });

    expect(describeRoom(machine).short).toBe("Full");
  });

  it("is not reduced by a reserved runner, labels, a runner that has not reported its disk or memory", () => {
    const machines = [
      buildMachine({ reserved: true, labels: ["gpu"] }),
      buildMachine({ watermark: null }),
      buildMachine({ watermark: { diskFreeBytes: 20 * GIB, availableMemoryBytes: 0 } }),
    ];

    expect(machines.map((machine) => describeRoom(machine).short)).toEqual([
      "Room for 16",
      "Room for 16",
      "Room for 16",
    ]);
  });

  it("counts a free disk equal to the limit as enough", () => {
    const machine = buildMachine({
      watermark: { diskFreeBytes: 10 * GIB, availableMemoryBytes: 8 * GIB },
    });

    expect(describeRoom(machine).short).toBe("Room for 16");
  });

  it("says Full when every slot is taken", () => {
    const machine = buildMachine({ maxConcurrentSessions: 16 }, { running: 16 });

    expect(describeRoom(machine).short).toBe("Full");
    expect(readLine(machine)).toBe("No room: it runs its cap of 16 sessions");
  });

  it("uses the singular for a cap of one", () => {
    const machine = buildMachine({ maxConcurrentSessions: 1 }, { running: 1 });

    expect(readLine(machine)).toBe("No room: it runs its cap of 1 session");
  });

  it("leaves the short text out for a disk below its limit, and names the disk in the line", () => {
    const machine = buildMachine({
      watermark: { diskFreeBytes: 5 * GIB, availableMemoryBytes: 8 * GIB },
    });

    expect(describeRoom(machine).short).toBeNull();
    expect(readLine(machine)).toBe(
      "No room: its disk is below its limit, so it takes no new sessions",
    );
  });

  it("leaves the short text out for a machine told to take no new work, because its status word says so", () => {
    const machine = buildMachine({ lifecycle: "draining" });

    expect(describeRoom(machine).short).toBeNull();
    expect(readLine(machine)).toBe("No room: it takes no new work");
  });

  it("still names the disk in the line, and leaves the short text out, when both apply", () => {
    const machine = buildMachine({
      lifecycle: "draining",
      watermark: { diskFreeBytes: 5 * GIB, availableMemoryBytes: 8 * GIB },
    });

    expect(describeRoom(machine).short).toBeNull();
    expect(readLine(machine)).toBe(
      "No room: its disk is below its limit, so it takes no new sessions",
    );
  });

  it.each(["offline", "unreachable"] as const)("has no text while the machine is %s", (state) => {
    expect(describeRoom(buildMachine({ connectivity: state }))).toEqual({
      short: null,
      line: null,
    });
  });
});

describe("buildSessionsDrawing", () => {
  const drawing = (
    cap: number,
    running: number,
    waiting = 0,
  ): ReturnType<typeof buildSessionsDrawing> =>
    buildSessionsDrawing(buildMachine({ maxConcurrentSessions: cap }, { running, waiting }));

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

describe("decideMachineKind", () => {
  it.each([
    ["linux", 8 * GIB, "server"],
    ["linux", 256 * GIB, "server"],
    ["darwin", 16 * GIB, "laptop"],
    ["darwin", 64 * GIB, "desktop"],
    ["win32", 128 * GIB, "desktop"],
    ["win32", 32 * GIB, "laptop"],
    ["freebsd", 128 * GIB, "laptop"],
  ])("takes %s with %d bytes of RAM for a %s", (os, totalMemoryBytes, kind) => {
    expect(decideMachineKind(buildFacts({ os, totalMemoryBytes }))).toBe(kind);
  });

  it("takes a machine that has not reported its facts for a laptop", () => {
    expect(decideMachineKind(null)).toBe("laptop");
  });
});

describe("summarizeMachine disk", () => {
  // The disk limit is 10 GiB; levels are checked apart, so only the size is read here.
  const readDisk = (diskFreeBytes: number) =>
    summarizeMachine(
      buildMachine({ watermark: { diskFreeBytes, availableMemoryBytes: 8 * GIB } }),
      TIMEZONE,
      NOW,
    ).disk;

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
});

describe("summarizeMachine memory", () => {
  const readMemory = (totalGib: number, availableGib: number) =>
    summarizeMachine(
      buildMachine({
        facts: buildFacts({ totalMemoryBytes: totalGib * GIB }),
        watermark: { diskFreeBytes: 20 * GIB, availableMemoryBytes: availableGib * GIB },
      }),
      TIMEZONE,
      NOW,
    ).memory;

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
      expect(readMemory(total, available)).toEqual({ percent, level });
    },
  );

  it("stays between 0 and 100 percent when the runner reports more available than total", () => {
    expect(readMemory(100, 120)).toEqual({ percent: 0, level: "normal" });
  });

  it("is null until the runner reports its total memory", () => {
    const machine = buildMachine({ facts: null });

    expect(summarizeMachine(machine, TIMEZONE, NOW).memory).toBeNull();
  });

  it("is null until the runner reports its available memory", () => {
    const machine = buildMachine({ facts: buildFacts(), watermark: null });

    expect(summarizeMachine(machine, TIMEZONE, NOW).memory).toBeNull();
  });
});

describe("describeMachineStatus", () => {
  it("has no word for an online machine", () => {
    expect(describeMachineStatus(buildRunner(), TIMEZONE, NOW)).toEqual({
      tone: "online",
      word: null,
    });
  });

  it("says Offline for an offline machine, also while draining", () => {
    const runner = buildRunner({ connectivity: "offline", lifecycle: "draining" });

    expect(describeMachineStatus(runner, TIMEZONE, NOW)).toEqual({
      tone: "offline",
      word: "Offline",
    });
  });

  it("says when an unreachable machine was last heard from", () => {
    const runner = buildRunner({ connectivity: "unreachable" });

    expect(describeMachineStatus(runner, TIMEZONE, NOW)).toEqual({
      tone: "offline",
      word: "Not heard from since 09:12",
    });
  });

  it("says Unreachable for an unreachable machine that was never seen", () => {
    const runner = buildRunner({ connectivity: "unreachable", lastSeenAt: null });

    expect(describeMachineStatus(runner, TIMEZONE, NOW).word).toBe("Unreachable");
  });

  it("says an online machine takes no new work while draining", () => {
    expect(describeMachineStatus(buildRunner({ lifecycle: "draining" }), TIMEZONE, NOW)).toEqual({
      tone: "draining",
      word: "Takes no new work",
    });
  });
});

describe("summarizeMachine", () => {
  it("gathers what a card draws for a healthy machine", () => {
    const machine = buildMachine(
      {
        facts: buildFacts({ totalMemoryBytes: 16 * GIB }),
        watermark: { diskFreeBytes: 42.14e9, availableMemoryBytes: 4 * GIB },
      },
      { running: 12 },
    );

    expect(summarizeMachine(machine, TIMEZONE, NOW)).toEqual({
      status: { tone: "online", word: null },
      isAway: false,
      drawing: buildSessionsDrawing(machine),
      roomText: "Room for 4",
      need: undefined,
      disk: { amount: "42.1", unit: "GB", level: "normal" },
      memory: { percent: 75, level: "normal" },
    });
  });

  it("marks a disk below its limit as failing and takes its first need", () => {
    const machine = buildMachine({
      watermark: { diskFreeBytes: 5 * GIB, availableMemoryBytes: 8 * GIB },
    });

    const summary = summarizeMachine(machine, TIMEZONE, NOW);

    expect(summary.disk?.level).toBe("fail");
    expect(summary.need?.kind).toBe("disk-below-limit");
    expect(summary.roomText).toBeNull();
  });

  it("has no room text for a machine told to take no new work, because its status word says so", () => {
    const summary = summarizeMachine(buildMachine({ lifecycle: "draining" }), TIMEZONE, NOW);

    expect(summary.status.word).toBe("Takes no new work");
    expect(summary.roomText).toBeNull();
  });

  it("has no disk, memory or room for an offline machine that never reported", () => {
    const machine = buildMachine({ connectivity: "offline", watermark: null });

    expect(summarizeMachine(machine, TIMEZONE, NOW)).toMatchObject({
      isAway: true,
      roomText: null,
      disk: null,
      memory: null,
      need: { kind: "offline" },
    });
  });
});

describe("describeMachinesSection", () => {
  it("counts the machines that need the user, or else all machines", () => {
    const calm = buildMachine({ id: "a" });
    const offline = buildMachine({ id: "b", connectivity: "offline" });

    expect(describeMachinesSection([calm, offline, buildFullMachine(2, { id: "c" })])).toEqual({
      text: "2 need you",
      isYou: true,
    });
    expect(describeMachinesSection([calm, buildMachine({ id: "d" })])).toEqual({
      text: "2",
      isYou: false,
    });
  });
});

describe("isFleetEmpty", () => {
  const local = buildMachine({ id: "local" });
  const remote = buildMachine({ id: "remote" });
  const remoteOffline = buildMachine({ id: "remote", connectivity: "offline" });

  it.each([
    ["no machine", [], "local", true],
    ["only the controller's own runner", [local], "local", true],
    ["a remote machine that is offline", [local, remoteOffline], "local", true],
    ["a remote machine that is online", [local, remote], "local", false],
    ["an online machine while the controller has no runner of its own", [remote], null, false],
  ] as const)("with %s the fleet is empty: %s", (_, machines, localRunnerId, expected) => {
    expect(isFleetEmpty(machines, localRunnerId)).toBe(expected);
  });
});
