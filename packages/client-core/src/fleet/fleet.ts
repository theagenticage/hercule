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
  buildSessionsDrawing,
  decideMachineKind,
  describeMachineStatus,
  describeRoom,
  listMachineNeeds,
  measureDisk,
  measureMemory,
  plural,
  splitDiskSize,
  type FleetMachine,
  type FleetTextPart,
  type GaugeLevel,
  type MachineKind,
  type MachineNeed,
  type MachineStatus,
  type SessionCountsByRunner,
  type SessionsDrawing,
} from "./machine";

export type {
  FleetTextPart,
  GaugeLevel,
  MachineKind,
  MachineNeed,
  MachineStatus,
  SessionsDrawing,
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
 * sessions wait for a slot, its disk is 85% full or more. The list is empty
 * when the machine needs nothing. `counts` holds the session counts of the
 * runners (the runner's own entry is used; none means no sessions). A time is
 * worded relative to `today` in `timezone`, and left out when the runner was
 * never seen.
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
   * machine's disk limit, else `you` from 85% full, else `normal`. `share` is
   * how full the disk is, from 0 to 1, and `percent` is the same rounded down
   * to a whole number. Both are `null` when the runner does not report its
   * total disk size, and the gauge then draws empty (spec 17 §Graphs).
   */
  readonly disk: {
    readonly amount: string;
    readonly unit: "MB" | "GB";
    readonly level: GaugeLevel;
    readonly share: number | null;
    readonly percent: number | null;
  } | null;
  /**
   * The memory in use as a whole percentage, rounded down, and as a share from
   * 0 to 1, or `null` before the runner has reported it.
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
  const disk = measureDisk(runner);
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
      disk === null
        ? null
        : {
            ...splitDiskSize(disk.freeBytes),
            level: disk.level,
            share: disk.share,
            percent: disk.percent,
          },
    memory:
      memory === null
        ? null
        : { percent: memory.percent, share: memory.share, level: memory.level },
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
