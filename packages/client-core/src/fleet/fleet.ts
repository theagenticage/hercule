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
import type { Runner, RunnerMetricsPoint, Session } from "@hercule/contract";
import { RUNNING_STATUSES } from "../runner-capacity";
import { forecastDiskLimit, type DiskForecast } from "./disk-forecast";
import {
  NO_SESSIONS,
  buildFleetMachine,
  buildNumberPart,
  buildPlainPart,
  countRoom,
  buildSessionsDrawing,
  decideMachineKind,
  decideMachineNeed,
  describeDiskGauge,
  describeForecastDays,
  describeMachineStatus,
  describeMemoryGauge,
  describeRoom,
  measureDisk,
  measureMemory,
  plural,
  type FleetMachine,
  type FleetTextPart,
  type MachineGauge,
  type MachineKind,
  type MachineNeed,
  type MachineStatus,
  type SessionCountsByRunner,
  type SessionsDrawing,
} from "./machine";
import type { RunnerMetricsHistory } from "./metrics-history";

export { forecastDiskLimit, type DiskForecast } from "./disk-forecast";
export type {
  FleetTextPart,
  GaugeLevel,
  MachineGauge,
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
   * The disk as a gauge: the percentage full, or the free space while the
   * runner does not report its total disk size (spec 17 §Graphs). Its `level`
   * is `fail` while the free space is below the machine's disk limit, else
   * `you` from 85% full, else `normal`.
   */
  readonly disk: MachineGauge;
  /**
   * What a list row draws under the disk meter: "Limit in 12 days" while the
   * disk's forecast shows (`isForecast`, in the you colour), else the free
   * space, "69.8 GB free". The forecast shows whether or not the machine is
   * away.
   */
  readonly diskCaption: { readonly text: string; readonly isForecast: boolean };
  /** The memory in use as a gauge, as a whole percentage rounded down. */
  readonly memory: MachineGauge;
}

/** Builds everything a card and a list row draw for `machine`, so the two cannot disagree. */
const summarizeMachine = (
  machine: FleetMachine,
  need: MachineNeed | undefined,
  forecast: DiskForecast | null,
  timezone: string,
  today: Date,
): MachineSummary => {
  const { runner } = machine;
  const disk = describeDiskGauge(measureDisk(runner));
  return {
    runnerId: runner.id,
    name: runner.name,
    kind: decideMachineKind(runner.facts),
    status: describeMachineStatus(runner, timezone, today),
    isAway: runner.connectivity !== "online",
    drawing: buildSessionsDrawing(machine),
    roomText: describeRoom(machine)?.short ?? null,
    need,
    disk,
    diskCaption:
      forecast === null
        ? { text: `${disk.freeAmount} free`, isForecast: false }
        : { text: `Limit in ${describeForecastDays(forecast)}`, isForecast: true },
    memory: describeMemoryGauge(measureMemory(runner)),
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

/** Groups points by their runner in one pass, each group keeping the order of the points. */
const groupPointsByRunner = (
  points: readonly RunnerMetricsPoint[],
): ReadonlyMap<string, readonly RunnerMetricsPoint[]> => {
  const groups = new Map<string, RunnerMetricsPoint[]>();
  for (const point of points) {
    const group = groups.get(point.runnerId);
    if (group === undefined) groups.set(point.runnerId, [point]);
    else group.push(point);
  }
  return groups;
};

/**
 * Builds the Fleet page from the runners and the counts of their sessions.
 * `metricsHistory` holds the hour points of every runner, for the disk
 * forecasts. `localRunnerId` is the controller's own runner, or `null` when it
 * has none. Times are worded in `timezone`, relative to `today`.
 *
 * The page shows one machine per runner that is not retired. Counts of a
 * runner that is not in `runners` are ignored. The machines are sorted by
 * runner id. A runner id is a UUIDv7, which starts with its creation time, so
 * this is the order the machines joined. That order never changes while the
 * page is open, so no card jumps when a state changes.
 *
 * Each machine's disk forecast and need are computed once, and the lead, the
 * section count and the machines all read the same ones.
 */
export const describeFleetPage = (
  runners: readonly Runner[],
  counts: SessionCountsByRunner,
  metricsHistory: RunnerMetricsHistory,
  localRunnerId: string | null,
  timezone: string,
  today: Date,
): FleetPage => {
  const pointsByRunner = groupPointsByRunner(metricsHistory.points);
  const entries = runners
    .filter((runner) => runner.lifecycle !== "retired")
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((runner) => {
      const machine = buildFleetMachine(runner, counts);
      const forecast = forecastDiskLimit(
        pointsByRunner.get(runner.id) ?? [],
        runner,
        metricsHistory.readAt,
      );
      return { machine, forecast, need: decideMachineNeed(machine, forecast, timezone, today) };
    });
  const machines = entries.map((entry) => entry.machine);
  const needing = entries.filter((entry) => entry.need !== undefined).length;
  return {
    lead: describeLead(machines, needing),
    machinesSection:
      needing > 0
        ? { text: `${String(needing)} need you`, isYou: true }
        : { text: String(machines.length), isYou: false },
    isEmpty: !machines.some(
      ({ runner }) => runner.id !== localRunnerId && runner.connectivity === "online",
    ),
    machines: entries.map(({ machine, need, forecast }) =>
      summarizeMachine(machine, need, forecast, timezone, today),
    ),
  };
};
