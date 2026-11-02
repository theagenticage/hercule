/**
 * The pure logic of the desktop Fleet screen: which machines the screen shows,
 * what each one needs from the user, how much room it has, and the words and
 * counts the cards, the list and the machine page draw from. No function here
 * reads a clock or a store; the caller passes the runners, the sessions and
 * "now".
 *
 * This module is its own subpath (`@hercule/client-core/fleet`) and is not
 * re-exported from the package index, so the first screen does not carry it.
 */
import type { Runner, RunnerFacts, Session } from "@hercule/contract";
import { RUNNING_STATUSES } from "../runner-capacity";
import { formatLastSeen } from "./last-seen";

const holdsSlot = new Set<string>(RUNNING_STATUSES);

/** How many sessions a runner holds, by what they are doing. */
export interface RunnerSessionCounts {
  /** Sessions starting, idle or busy on it. */
  readonly running: number;
  /** Sessions queued on it. */
  readonly waiting: number;
  /** Of the waiting sessions, the Threads. */
  readonly waitingThreads: number;
  /** Threads on it that have not exited, queued or not. */
  readonly openThreads: number;
}

/** The counts of every runner that has a session, by runner id. */
export type SessionCountsByRunner = Readonly<Record<string, RunnerSessionCounts>>;

const NO_SESSIONS: RunnerSessionCounts = {
  running: 0,
  waiting: 0,
  waitingThreads: 0,
  openThreads: 0,
};

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
  const counts: Record<string, { -readonly [K in keyof RunnerSessionCounts]: number }> = {};
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

/** One machine of the Fleet: its runner and the counts of its sessions. */
export interface FleetMachine extends RunnerSessionCounts {
  readonly runner: Runner;
}

/** Returns the machine of `runner` with its entry in `counts`, or no sessions when it has none. */
export const buildFleetMachine = (runner: Runner, counts: SessionCountsByRunner): FleetMachine => ({
  runner,
  ...(counts[runner.id] ?? NO_SESSIONS),
});

/**
 * Returns the machines the Fleet screen shows: one per runner that is not
 * retired, with the counts of its sessions. Counts of a runner that is not in
 * `runners` are ignored.
 *
 * The machines are sorted by runner id. A runner id is a UUIDv7, which starts
 * with its creation time, so this is the order the machines joined. That order
 * never changes while the page is open, so no card jumps when a state changes.
 */
export const buildFleetMachines = (
  runners: readonly Runner[],
  counts: SessionCountsByRunner,
): readonly FleetMachine[] =>
  runners
    .filter((runner) => runner.lifecycle !== "retired")
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((runner) => buildFleetMachine(runner, counts));

/**
 * Checks whether the machine's free disk is below its disk limit, which is
 * when the controller places no new session on it. Equal is not below. False
 * when the runner has not reported its disk yet.
 */
const isDiskBelowLimit = (runner: Runner): boolean =>
  runner.watermark !== null && runner.watermark.diskFreeBytes < runner.diskWatermarkBytes;

/**
 * Checks whether the controller places new sessions on the machine: it is
 * online, the user has not told it to take no new work (draining), and its
 * disk is not below its limit. Memory takes no part.
 */
const canTakeNewSessions = (runner: Runner): boolean =>
  runner.connectivity === "online" && runner.lifecycle === "active" && !isDiskBelowLimit(runner);

/**
 * Counts the sessions the machine can still start: the free slots under its
 * session cap. It is 0 when the machine cannot take new sessions.
 */
const countRoom = (machine: FleetMachine): number =>
  canTakeNewSessions(machine.runner)
    ? Math.max(0, machine.runner.maxConcurrentSessions - machine.running)
    : 0;

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

/** Words an unreachable machine: "Not heard from since 09:12", or "Unreachable" when it was never seen. */
const describeUnreachable = (seen: string | null): string =>
  seen === null ? "Unreachable" : `Not heard from since ${seen}`;

/**
 * A reason a machine needs the user. `hue` is the colour family of its line:
 * `fail` for a machine that cannot take work, `you` for work that waits on the
 * user's decision.
 */
export type MachineNeed =
  | { readonly kind: "offline" | "unreachable"; readonly hue: "fail"; readonly line: string }
  | { readonly kind: "disk-below-limit"; readonly hue: "fail"; readonly line: string }
  | {
      readonly kind: "waiting";
      readonly hue: "you";
      readonly line: string;
      /** The session cap that lets every waiting session start: running plus waiting. */
      readonly allow: number;
      /** The tooltip of the button that sets the cap to `allow`. */
      readonly allowHint: string;
    };

type NeedKind = MachineNeed["kind"];

/**
 * Lists the kinds of need that apply to a machine, in the order the card
 * shows them.
 *
 * Sessions wait for a slot only when the cap is what holds them back. That is
 * when the machine takes new sessions (online, not draining, disk not below its
 * limit) and running plus waiting is above the cap. Otherwise raising the cap
 * would start nothing: a queued session that would fit under the cap waits for
 * something else (a workspace, an account), and a machine that is away, told to
 * take no new work, or low on disk starts no session whatever its cap. The
 * first two needs already name the machine's state. The rule also keeps the
 * Allow button from ever lowering the cap: its value, running plus waiting, is
 * above the cap by construction.
 */
const listNeedKinds = (machine: FleetMachine): readonly NeedKind[] => {
  const { runner } = machine;
  const kinds: NeedKind[] = [];
  if (runner.connectivity === "offline") kinds.push("offline");
  if (runner.connectivity === "unreachable") kinds.push("unreachable");
  if (isDiskBelowLimit(runner)) kinds.push("disk-below-limit");
  const isCapHoldingSessionsBack =
    canTakeNewSessions(runner) &&
    machine.waiting > 0 &&
    machine.running + machine.waiting > runner.maxConcurrentSessions;
  if (isCapHoldingSessionsBack) kinds.push("waiting");
  return kinds;
};

const describeWaiting = (machine: FleetMachine): string => {
  const { waiting, waitingThreads } = machine;
  const noun = waitingThreads === waiting ? "thread" : "session";
  return waiting === 1
    ? `1 ${noun} waits for a slot`
    : `${String(waiting)} ${noun}s wait for a slot`;
};

const describeAllowHint = (machine: FleetMachine): string => {
  const { running, waiting } = machine;
  const total = running + waiting;
  const parts =
    running === 0
      ? `the ${String(waiting)} waiting`
      : `the ${String(running)} running and the ${String(waiting)} waiting`;
  return `Lets ${String(total)} ${plural(total, "session", "sessions")} run here at once: ${parts}.`;
};

/**
 * Returns every need that applies to a machine, the most serious first: it is
 * offline, it is unreachable, its disk is below its limit, sessions wait for a
 * slot. The card shows the first; the list is empty when the machine needs
 * nothing. A time is shown relative to `now` in `timezone`, and left out when
 * the runner was never seen.
 */
export const findMachineNeeds = (
  machine: FleetMachine,
  timezone: string,
  now: Date,
): readonly MachineNeed[] => {
  const seen = formatLastSeen(machine.runner, timezone, now);
  return listNeedKinds(machine).map((kind): MachineNeed => {
    switch (kind) {
      case "offline":
        return {
          kind,
          hue: "fail",
          line: seen === null ? "Offline" : `Offline since ${seen}`,
        };
      case "unreachable":
        return {
          kind,
          hue: "fail",
          line: describeUnreachable(seen),
        };
      case "disk-below-limit":
        return {
          kind,
          hue: "fail",
          line: "Disk below its limit. It takes no new sessions.",
        };
      case "waiting":
        return {
          kind,
          hue: "you",
          line: describeWaiting(machine),
          allow: machine.running + machine.waiting,
          allowHint: describeAllowHint(machine),
        };
    }
  });
};

/**
 * A piece of a sentence the Fleet screen builds, such as the lead or a
 * machine's room line. A renderer draws `count` in the "you" ink (the number
 * of machines that need the user), `number` in bold, and `plain` as is.
 */
export interface FleetTextPart {
  readonly text: string;
  readonly kind: "plain" | "count" | "number";
}

/** The Fleet page's lead: a headline, and under it one line of totals. */
export interface FleetLead {
  readonly headline: readonly FleetTextPart[];
  readonly detail: readonly FleetTextPart[];
}

/** Counts the machines with at least one need. */
const countMachinesNeedingUser = (machines: readonly FleetMachine[]): number =>
  machines.filter((machine) => listNeedKinds(machine).length > 0).length;

const COUNT_WORDS = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

const buildPlainPart = (text: string): FleetTextPart => ({ text, kind: "plain" });
const buildNumberPart = (value: number): FleetTextPart => ({ text: String(value), kind: "number" });

/**
 * Builds the lead of the Fleet page from its machines, such as "Three
 * machines need you." over "93 sessions running on 5 machines, 3 waiting. Room
 * for 40 more right now."
 *
 * - The headline counts the machines with at least one need. With none it is
 *   "Every machine is healthy.". The count is a word up to ten ("Three"),
 *   digits after that.
 * - With no machine at all the headline is "No machine has joined yet." and
 *   there is no detail.
 * - The detail sums the running and waiting sessions and the room over the
 *   online machines, and counts those machines. The waiting part is left out
 *   at 0, and a room of 0 reads "No room right now.".
 * - With no machine online the detail is "No machine is online.".
 */
export const describeFleet = (machines: readonly FleetMachine[]): FleetLead => {
  if (machines.length === 0)
    return { headline: [buildPlainPart("No machine has joined yet.")], detail: [] };

  const needing = countMachinesNeedingUser(machines);
  const headline: readonly FleetTextPart[] =
    needing === 0
      ? [buildPlainPart("Every machine is healthy.")]
      : [
          {
            text: COUNT_WORDS[needing - 1] ?? String(needing),
            kind: "count",
          },
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

/**
 * Describes how much room a machine has. `short` is the text of a card or a
 * list row ("Room for 4", "Full", "Takes no new work"). `line` is the machine
 * page's sentence about it, in parts so the number can be drawn in bold.
 *
 * - Both are `null` while the machine is offline or unreachable, because the
 *   screen shows that state instead.
 * - `short` is also `null` while the machine is told to take no new work,
 *   because its status word already says so.
 * - When the disk is below its limit and the machine is also set to take no
 *   new work, the line names the disk, because that is the one the user can
 *   fix by cleaning up.
 */
export const describeRoom = (
  machine: FleetMachine,
): {
  readonly short: string | null;
  readonly line: readonly FleetTextPart[] | null;
} => {
  const { runner } = machine;
  if (runner.connectivity !== "online") return { short: null, line: null };

  const room = countRoom(machine);
  const cap = runner.maxConcurrentSessions;
  const isDraining = runner.lifecycle === "draining";
  if (isDiskBelowLimit(runner)) {
    return {
      short: isDraining ? null : "Takes no new work",
      line: [buildPlainPart("No room: its disk is below its limit, so it takes no new sessions")],
    };
  }
  if (isDraining) return { short: null, line: [buildPlainPart("No room: it takes no new work")] };
  if (room === 0) {
    return {
      short: "Full",
      line: [
        buildPlainPart(
          `No room: it runs its cap of ${String(cap)} ${plural(cap, "session", "sessions")}`,
        ),
      ],
    };
  }
  return {
    short: `Room for ${String(room)}`,
    line: [
      buildPlainPart("Room for "),
      buildNumberPart(room),
      buildPlainPart(` more, under its cap of ${String(cap)}`),
    ],
  };
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
 * blocks. It takes the machine rather than several numbers so the card cannot
 * pass the counts in the wrong order. A machine running more sessions than its
 * cap has 0 free slots, never a negative number.
 */
export const buildSessionsDrawing = (machine: FleetMachine): SessionsDrawing => {
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

/** The icon a machine gets. */
export type MachineKind = "laptop" | "desktop" | "server";

/** The RAM from which a macOS or Windows machine is taken for a desktop: 64 GiB. */
const DESKTOP_MEMORY_BYTES = 64 * 1024 ** 3;

/**
 * Guesses what kind of computer a machine is from its facts, for its icon.
 * Linux is a server. macOS (`darwin`) or Windows (`win32`) with 64 GiB of RAM
 * or more is a desktop. Any other machine, including one that has not
 * reported its facts, is a laptop.
 */
export const decideMachineKind = (facts: RunnerFacts | null): MachineKind => {
  if (facts === null) return "laptop";
  if (facts.os === "linux") return "server";
  const isDesktopOs = facts.os === "darwin" || facts.os === "win32";
  return isDesktopOs && facts.totalMemoryBytes >= DESKTOP_MEMORY_BYTES ? "desktop" : "laptop";
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
  if (runner.facts === null || runner.watermark === null) return null;
  const total = runner.facts.totalMemoryBytes;
  if (total <= 0) return null;
  const share = Math.min(1, Math.max(0, (total - runner.watermark.availableMemoryBytes) / total));
  const level = share >= MEMORY_FAIL_FROM ? "fail" : share >= MEMORY_YOU_FROM ? "you" : "normal";
  return { share, level };
};

/** The status dot of a machine and the word beside it. See `describeMachineStatus`. */
export interface MachineStatus {
  readonly tone: "online" | "offline" | "draining";
  readonly word: string | null;
}

/**
 * Describes the status dot of a machine. `tone` is the dot: `offline` for an
 * offline or unreachable runner, `draining` for an online runner told to take
 * no new work, else `online`. `word` is shown beside the dot and is `null`
 * when the machine is simply online: "Offline", "Not heard from since 09:12"
 * (unreachable, or "Unreachable" when it was never seen), or "Takes no new
 * work". An offline machine is "Offline" even when it is also draining.
 */
export const describeMachineStatus = (
  runner: Runner,
  timezone: string,
  now: Date,
): MachineStatus => {
  if (runner.connectivity === "offline") return { tone: "offline", word: "Offline" };
  if (runner.connectivity === "unreachable") {
    const seen = formatLastSeen(runner, timezone, now);
    return {
      tone: "offline",
      word: describeUnreachable(seen),
    };
  }
  if (runner.lifecycle === "draining") return { tone: "draining", word: "Takes no new work" };
  return { tone: "online", word: null };
};

/** What a card or a list row of the Fleet draws for one machine. See `summarizeMachine`. */
export interface MachineSummary {
  /** The status dot and its word, which is `null` while the machine is simply online. */
  readonly status: MachineStatus;
  /** Whether the machine is offline or unreachable, which a card shows dimmed. */
  readonly isAway: boolean;
  readonly drawing: SessionsDrawing;
  /**
   * "Room for 4", "Full" or "Takes no new work" (a disk below its limit); `null`
   * while the machine is away or draining, because its status word says so.
   */
  readonly roomText: string | null;
  /** The most serious need, or `undefined` when the machine needs nothing. */
  readonly need: MachineNeed | undefined;
  /**
   * The free disk space as a number and a unit, or `null` before the runner has
   * reported its disk. `level` is `fail` while the free space is below the
   * machine's disk limit, else `normal`.
   */
  readonly disk: {
    readonly amount: string;
    readonly unit: "MB" | "GB";
    readonly level: GaugeLevel;
  } | null;
  /** The memory in use as a whole percentage, or `null` before the runner has reported it. */
  readonly memory: { readonly percent: number; readonly level: GaugeLevel } | null;
}

/**
 * Computes everything the Fleet's card and list row draw for a machine, so the
 * two cannot disagree. Times are shown in `timezone`, relative to `now`.
 */
export const summarizeMachine = (
  machine: FleetMachine,
  timezone: string,
  now: Date,
): MachineSummary => {
  const { runner } = machine;
  const memory = measureMemory(runner);
  return {
    status: describeMachineStatus(runner, timezone, now),
    isAway: runner.connectivity !== "online",
    drawing: buildSessionsDrawing(machine),
    roomText: describeRoom(machine).short,
    need: findMachineNeeds(machine, timezone, now)[0],
    disk:
      runner.watermark === null
        ? null
        : {
            ...splitDiskSize(runner.watermark.diskFreeBytes),
            level: isDiskBelowLimit(runner) ? "fail" : "normal",
          },
    memory:
      memory === null ? null : { percent: Math.round(memory.share * 100), level: memory.level },
  };
};

/**
 * Describes the Machines section for its jump link in the page header: "2 need
 * you" with `isYou` set while some machines need the user, else the number of
 * machines.
 */
export const describeMachinesSection = (
  machines: readonly FleetMachine[],
): { readonly text: string; readonly isYou: boolean } => {
  const needing = countMachinesNeedingUser(machines);
  return needing > 0
    ? { text: `${String(needing)} need you`, isYou: true }
    : { text: String(machines.length), isYou: false };
};

/**
 * Checks whether the fleet is still empty: no machine other than the
 * controller's own runner (`localRunnerId`, `null` when it has none) is
 * online. The screen then invites the user to add a machine.
 */
export const isFleetEmpty = (
  machines: readonly FleetMachine[],
  localRunnerId: string | null,
): boolean =>
  !machines.some(({ runner }) => runner.id !== localRunnerId && runner.connectivity === "online");
