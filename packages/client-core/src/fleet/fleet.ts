/**
 * The pure logic of the desktop Fleet page: which machines it shows, what each
 * one needs from the user, how much room it has, and the words and numbers the
 * lead, the cards and the list draw. No function here reads a clock or a
 * store; the caller passes the runners, the session counts and `today`.
 *
 * `today` is any instant on the user's current calendar day, not the current
 * instant. A time worded here ("Offline since 09:12") depends on `today` only
 * through its date, so a caller can pass the start of the day and have the
 * words change at midnight and at no other moment.
 *
 * This module is its own subpath (`@hercule/client-core/fleet`) and is not
 * re-exported from the package index, so the first screen does not carry it.
 */
import type { Runner, Session } from "@hercule/contract";
import { RUNNING_STATUSES } from "../runner-capacity";
import {
  NO_SESSIONS,
  buildFleetMachine,
  buildNumberPart,
  buildPlainPart,
  countRoom,
  decideMachineKind,
  describeMachineStatus,
  describeRoom,
  isDiskBelowLimit,
  listMachineNeeds,
  plural,
  type FleetMachine,
  type FleetTextPart,
  type MachineKind,
  type MachineNeed,
  type MachineStatus,
  type SessionCountsByRunner,
} from "./machine";

export type {
  FleetTextPart,
  MachineKind,
  MachineNeed,
  MachineStatus,
  SessionCountsByRunner,
} from "./machine";

const holdsSlot = new Set<string>(RUNNING_STATUSES);

/**
 * Counts the sessions of every runner by what they are doing. A runner with
 * no session has no entry. Sessions that have exited count as nothing.
 *
 * The Fleet pages read their sessions through this function as a query's
 * `select`, so a component gets these counts and never the session list. A
 * push that only changes a session's usage or last activity then changes no
 * count, TanStack's structural sharing hands back the object it returned
 * before, and nothing on the page renders again.
 */
export const countRunnerSessions = (sessions: readonly Session[]): SessionCountsByRunner => {
  const counts: Record<string, { -readonly [K in keyof typeof NO_SESSIONS]: number }> = {};
  for (const session of sessions) {
    const count = (counts[session.runnerId] ??= { ...NO_SESSIONS });
    if (holdsSlot.has(session.status)) count.running += 1;
    else if (session.status === "queued") {
      count.waiting += 1;
      if (session.kind === "thread") count.waitingThreads += 1;
    }
    if (session.kind === "thread" && session.status !== "exited") count.openThreads += 1;
  }
  return counts;
};

/**
 * Returns every need that applies to the machine of `runner`, the most serious
 * first: it is offline, it is unreachable, its disk is below its limit,
 * sessions wait for a slot. The list is empty when the machine needs nothing.
 * `counts` holds the session counts of the runners (the runner's own entry is
 * used; none means no sessions). A time is worded relative to `today` in
 * `timezone`, and left out when the runner was never seen.
 *
 * Takes the runner and the counts rather than a machine type, so that type
 * stays private to the Fleet modules.
 */
export const findMachineNeeds = (
  runner: Runner,
  counts: SessionCountsByRunner,
  timezone: string,
  today: Date,
): readonly MachineNeed[] => listMachineNeeds(buildFleetMachine(runner, counts), timezone, today);

/** The Fleet page's lead: a headline, and under it one line of totals. */
export interface FleetLead {
  readonly headline: readonly FleetTextPart[];
  readonly detail: readonly FleetTextPart[];
}

const COUNT_WORDS = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

/**
 * Builds the lead of the Fleet page from its machines, such as "Three
 * machines need you." over "93 sessions running on 5 machines, 3 waiting. Room
 * for 40 more right now." `needing` is the number of machines with at least
 * one need.
 *
 * - The headline counts the machines that need the user. With none it is
 *   "Every machine is healthy.". The count is a word up to ten ("Three"),
 *   digits after that.
 * - With no machine at all the headline is "No machine has joined yet." and
 *   there is no detail.
 * - The detail sums the running and waiting sessions and the room over the
 *   online machines, and counts those machines. The waiting part is left out
 *   at 0, and a room of 0 reads "No room right now.".
 * - With no machine online the detail is "No machine is online.".
 */
const describeLead = (machines: readonly FleetMachine[], needing: number): FleetLead => {
  if (machines.length === 0)
    return { headline: [buildPlainPart("No machine has joined yet.")], detail: [] };

  const headline: readonly FleetTextPart[] =
    needing === 0
      ? [buildPlainPart("Every machine is healthy.")]
      : [
          { text: COUNT_WORDS[needing - 1] ?? String(needing), kind: "count" },
          buildPlainPart(` ${plural(needing, "machine needs", "machines need")} you.`),
        ];

  const online = machines.filter((machine) => machine.runner.connectivity === "online");
  if (online.length === 0) return { headline, detail: [buildPlainPart("No machine is online.")] };

  const running = online.reduce((sum, machine) => sum + machine.running, 0);
  const waiting = online.reduce((sum, machine) => sum + machine.waiting, 0);
  const room = online.reduce((sum, machine) => sum + countRoom(machine), 0);
  const detail: readonly FleetTextPart[] = [
    buildNumberPart(running),
    buildPlainPart(` ${plural(running, "session", "sessions")} running on `),
    buildNumberPart(online.length),
    buildPlainPart(` ${plural(online.length, "machine", "machines")}`),
    ...(waiting > 0
      ? [buildPlainPart(", "), buildNumberPart(waiting), buildPlainPart(" waiting")]
      : []),
    buildPlainPart(". "),
    ...(room > 0
      ? [buildPlainPart("Room for "), buildNumberPart(room), buildPlainPart(" more right now.")]
      : [buildPlainPart("No room right now.")]),
  ];
  return { headline, detail };
};

/** The most slots, and the most waiting sessions, drawn one block each. */
const MAX_BLOCKS = 16;

/**
 * How to draw a machine's sessions against its cap. `blocks` is one block per
 * slot, `bar` is one bar cut every 10 sessions. `running` slots are filled,
 * `free` slots are empty, and `waiting` is the number of sessions waiting for
 * a slot, drawn as marigold after the cap. The drawn total is
 * `max(cap, running) + waiting`: after the user lowers the cap below the
 * sessions running, `free` is 0 and `running` runs past the cap. The renderer
 * needs `cap` to mark where the cap ends in that case, and where the waiting
 * part starts.
 *
 * `waitingBlocks` is how many waiting blocks the `blocks` shape draws: at most
 * 16, because the drawing is clipped to its place anyway and the text beside it
 * carries the count. It is 0 for a `bar`, which draws one stretch for all of
 * `waiting`.
 */
export interface SessionsDrawing {
  readonly shape: "blocks" | "bar";
  readonly cap: number;
  readonly running: number;
  readonly free: number;
  readonly waiting: number;
  readonly waitingBlocks: number;
}

/**
 * Returns the counts to draw a machine's sessions from: blocks while both the
 * cap and the sessions running are at most 16, a bar otherwise. A cap lowered
 * from 100 to 4 under 100 running sessions is therefore a bar, not 100
 * blocks. A machine running more sessions than its cap has 0 free slots, never
 * a negative number.
 */
const buildSessionsDrawing = (machine: FleetMachine): SessionsDrawing => {
  const cap = machine.runner.maxConcurrentSessions;
  const shape = cap <= MAX_BLOCKS && machine.running <= MAX_BLOCKS ? "blocks" : "bar";
  return {
    shape,
    cap,
    running: machine.running,
    free: Math.max(0, cap - machine.running),
    waiting: machine.waiting,
    waitingBlocks: shape === "blocks" ? Math.min(machine.waiting, MAX_BLOCKS) : 0,
  };
};

/**
 * Splits a size in bytes into a number and a unit, the way Finder shows it, in
 * units of 10^9 bytes:
 *
 * - under a gigabyte, whole megabytes: "420" "MB";
 * - from a gigabyte, gigabytes with one decimal under 100 GB: "10.7" "GB";
 * - from 100 GB, whole gigabytes, with a thousands separator from 1,000 GB:
 *   "245" "GB", "1,953" "GB". There is no terabyte unit.
 *
 * The tier is picked from the rounded number, so 99.96 GB reads "100 GB" and
 * not "100.0 GB".
 */
const splitDiskSize = (bytes: number): { readonly amount: string; readonly unit: "MB" | "GB" } => {
  const megabytes = Math.round(bytes / 1e6);
  if (megabytes < 1000) return { amount: String(megabytes), unit: "MB" };
  const gigabytes = bytes / 1e9;
  const tenths = Math.round(gigabytes * 10) / 10;
  if (tenths < 100) return { amount: tenths.toFixed(1), unit: "GB" };
  return { amount: Math.round(gigabytes).toLocaleString("en-US"), unit: "GB" };
};

/** How full a gauge is: `normal`, `you` (getting high), or `fail` (too high). */
export type GaugeLevel = "normal" | "you" | "fail";

const MEMORY_YOU_FROM = 0.8;
const MEMORY_FAIL_FROM = 0.92;

/**
 * Measures the memory in use on a machine: `share` is the part of its RAM
 * that is not available, from 0 to 1, and `level` is `you` from 80% and
 * `fail` from 92%. Returns `null` when the runner has not reported its total
 * memory or its available memory. A high level is only a colour: memory never
 * makes a machine need the user.
 */
const measureMemory = (
  runner: Runner,
): { readonly share: number; readonly level: GaugeLevel } | null => {
  if (runner.facts === null || runner.metrics === null) return null;
  const total = runner.facts.totalMemoryBytes;
  if (total <= 0) return null;
  const share = Math.min(1, Math.max(0, (total - runner.metrics.availableMemoryBytes) / total));
  const level = share >= MEMORY_FAIL_FROM ? "fail" : share >= MEMORY_YOU_FROM ? "you" : "normal";
  return { share, level };
};

/** What a card or a list row of the Fleet draws for one machine, fully worded. */
export interface MachineSummary {
  readonly runnerId: string;
  readonly name: string;
  /** The machine's icon. */
  readonly kind: MachineKind;
  /**
   * The status dot and its label. A card draws the label only when the tone is
   * not `online`; a list row draws it always.
   */
  readonly status: MachineStatus;
  /** Whether the machine is offline or unreachable, which a card shows dimmed. */
  readonly isAway: boolean;
  readonly drawing: SessionsDrawing;
  /**
   * "Room for 4" or "Full"; `null` while the machine is away, takes no new
   * work, or has its disk below its limit, because its status label or its
   * need line says so.
   */
  readonly roomText: string | null;
  /** The most serious need, or `undefined` when the machine needs nothing. */
  readonly need: MachineNeed | undefined;
  /**
   * The free disk space as a number and a unit, or `null` before the runner has
   * reported its disk. `level` is `fail` while the free space is below the
   * machine's disk limit, else `normal`. `share` is how full the disk is, from
   * 0 to 1; it is `null` until the runner reports its total disk size (it does
   * not yet), and the gauge then draws empty (spec 17 §Graphs).
   */
  readonly disk: {
    readonly amount: string;
    readonly unit: "MB" | "GB";
    readonly level: GaugeLevel;
    readonly share: number | null;
  } | null;
  /**
   * The memory in use as a whole percentage and as a share from 0 to 1, or
   * `null` before the runner has reported it.
   */
  readonly memory: {
    readonly percent: number;
    readonly share: number;
    readonly level: GaugeLevel;
  } | null;
}

/** Builds everything a card and a list row draw for `machine`, so the two cannot disagree. */
const summarizeMachine = (
  machine: FleetMachine,
  needs: readonly MachineNeed[],
  timezone: string,
  today: Date,
): MachineSummary => {
  const { runner } = machine;
  const memory = measureMemory(runner);
  return {
    runnerId: runner.id,
    name: runner.name,
    kind: decideMachineKind(runner.facts),
    status: describeMachineStatus(runner, timezone, today),
    isAway: runner.connectivity !== "online",
    drawing: buildSessionsDrawing(machine),
    roomText: describeRoom(machine)?.short ?? null,
    need: needs[0],
    disk:
      runner.metrics === null
        ? null
        : {
            ...splitDiskSize(runner.metrics.diskFreeBytes),
            level: isDiskBelowLimit(runner) ? "fail" : "normal",
            share: null,
          },
    memory:
      memory === null
        ? null
        : { percent: Math.round(memory.share * 100), share: memory.share, level: memory.level },
  };
};

/** Everything the Fleet page draws. See `describeFleetPage`. */
export interface FleetPage {
  readonly lead: FleetLead;
  /**
   * The Machines section's jump link in the page header: "2 need you" with
   * `isYou` set while some machines need the user, else the number of machines.
   */
  readonly machinesSection: { readonly text: string; readonly isYou: boolean };
  /**
   * Whether no machine other than the controller's own runner is online. The
   * page then invites the user to add a machine.
   */
  readonly isEmpty: boolean;
  readonly machines: readonly MachineSummary[];
}

/**
 * Builds the Fleet page from the runners and the counts of their sessions.
 * `localRunnerId` is the controller's own runner, or `null` when it has none.
 * Times are worded in `timezone`, relative to `today`.
 *
 * The page shows one machine per runner that is not retired. Counts of a
 * runner that is not in `runners` are ignored. The machines are sorted by
 * runner id. A runner id is a UUIDv7, which starts with its creation time, so
 * this is the order the machines joined. That order never changes while the
 * page is open, so no card jumps when a state changes.
 *
 * Each machine's needs are computed once, and the lead, the section count and
 * the machines all read the same list.
 */
export const describeFleetPage = (
  runners: readonly Runner[],
  counts: SessionCountsByRunner,
  localRunnerId: string | null,
  timezone: string,
  today: Date,
): FleetPage => {
  const entries = runners
    .filter((runner) => runner.lifecycle !== "retired")
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((runner) => {
      const machine = buildFleetMachine(runner, counts);
      return { machine, needs: listMachineNeeds(machine, timezone, today) };
    });
  const machines = entries.map((entry) => entry.machine);
  const needing = entries.filter((entry) => entry.needs.length > 0).length;
  return {
    lead: describeLead(machines, needing),
    machinesSection:
      needing > 0
        ? { text: `${String(needing)} need you`, isYou: true }
        : { text: String(machines.length), isYou: false },
    isEmpty: !machines.some(
      ({ runner }) => runner.id !== localRunnerId && runner.connectivity === "online",
    ),
    machines: entries.map(({ machine, needs }) =>
      summarizeMachine(machine, needs, timezone, today),
    ),
  };
};
