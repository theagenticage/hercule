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
import { formatShortMoment } from "../time-context";

const holdsSlot = new Set<string>(RUNNING_STATUSES);

/** One machine of the Fleet: its runner and the counts of its open sessions. */
export interface FleetMachine {
  readonly runner: Runner;
  /** Sessions starting, idle or busy on it. */
  readonly running: number;
  /** Sessions queued on it. */
  readonly waiting: number;
  /** Of the waiting sessions, the Threads. */
  readonly waitingThreads: number;
}

/**
 * Returns the machines the Fleet screen shows: one per runner that is not
 * retired, with the counts of the sessions open on it. Sessions on a runner
 * that is not in `runners` are ignored.
 *
 * The machines are sorted by runner id. A runner id is a UUIDv7, which starts
 * with its creation time, so this is the order the machines joined. That order
 * never changes while the page is open, so no card jumps when a state changes.
 * The sessions are read once, however many runners there are.
 */
export const buildFleetMachines = (
  runners: readonly Runner[],
  sessions: readonly Session[],
): readonly FleetMachine[] => {
  const counts = new Map<string, { running: number; waiting: number; waitingThreads: number }>();
  const shown = runners
    .filter((runner) => runner.lifecycle !== "retired")
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const runner of shown) counts.set(runner.id, { running: 0, waiting: 0, waitingThreads: 0 });

  for (const session of sessions) {
    const count = counts.get(session.runnerId);
    if (count === undefined) continue;
    if (holdsSlot.has(session.status)) count.running += 1;
    else if (session.status === "queued") {
      count.waiting += 1;
      if (session.kind === "thread") count.waitingThreads += 1;
    }
  }

  return shown.map((runner) => ({ runner, ...counts.get(runner.id)! }));
};

/**
 * Checks whether the machine's free disk is below its disk limit, which is
 * when the controller places no new session on it. Equal is not below. False
 * when the runner has not reported its disk yet.
 */
export const isDiskBelowLimit = (runner: Runner): boolean =>
  runner.watermark !== null && runner.watermark.diskFreeBytes < runner.diskWatermarkBytes;

/**
 * Counts the sessions the machine can still start: the free slots under its
 * session cap. It is 0 when the machine is not online, when the user told it
 * to take no new work (draining), and when its disk is below its limit. Memory
 * takes no part.
 */
export const countRoom = (machine: FleetMachine): number => {
  const { runner } = machine;
  if (runner.connectivity !== "online" || runner.lifecycle === "draining") return 0;
  if (isDiskBelowLimit(runner)) return 0;
  return Math.max(0, runner.maxConcurrentSessions - machine.running);
};

const plural = (count: number, one: string, many: string): string => (count === 1 ? one : many);

/**
 * Formats when the runner was last heard from, as short as a card allows
 * ("09:12" today, "Mon 09:12" within a week, "4 Nov 09:12" before that).
 * Returns `null` when the runner was never seen or the time cannot be
 * formatted.
 */
const formatLastSeen = (runner: Runner, timezone: string, now: Date): string | null => {
  if (runner.lastSeenAt === null) return null;
  return formatShortMoment(new Date(runner.lastSeenAt), now, timezone) ?? null;
};

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
 * Sessions wait for a slot only when the cap is what holds them back, which is
 * when running plus waiting is above the cap. A queued session that would fit
 * under the cap waits for something else (a workspace, an account, the
 * machine's connection), and raising the cap would not start it. This also
 * keeps the Allow button from ever lowering the cap: its value, running plus
 * waiting, is above the cap by construction.
 */
const listNeedKinds = (machine: FleetMachine): readonly NeedKind[] => {
  const { runner } = machine;
  const kinds: NeedKind[] = [];
  if (runner.connectivity === "offline") kinds.push("offline");
  if (runner.connectivity === "unreachable") kinds.push("unreachable");
  if (isDiskBelowLimit(runner)) kinds.push("disk-below-limit");
  if (machine.waiting > 0 && machine.running + machine.waiting > runner.maxConcurrentSessions) {
    kinds.push("waiting");
  }
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
 * A piece of the Fleet lead. A renderer draws `count` in the "you" ink (the
 * number of machines that need the user), `number` in bold, and `plain` as is.
 */
export interface FleetLeadPart {
  readonly text: string;
  readonly kind: "plain" | "count" | "number";
}

/** The Fleet page's lead: a headline, and under it one line of totals. */
export interface FleetLead {
  readonly headline: readonly FleetLeadPart[];
  readonly detail: readonly FleetLeadPart[];
}

const COUNT_WORDS = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

const plain = (text: string): FleetLeadPart => ({ text, kind: "plain" });
const number = (value: number): FleetLeadPart => ({ text: String(value), kind: "number" });

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
  if (machines.length === 0) return { headline: [plain("No machine has joined yet.")], detail: [] };

  const needing = machines.filter((machine) => listNeedKinds(machine).length > 0).length;
  const headline: readonly FleetLeadPart[] =
    needing === 0
      ? [plain("Every machine is healthy.")]
      : [
          {
            text: COUNT_WORDS[needing - 1] ?? String(needing),
            kind: "count",
          },
          plain(` ${plural(needing, "machine needs", "machines need")} you.`),
        ];

  const online = machines.filter((machine) => machine.runner.connectivity === "online");
  if (online.length === 0) return { headline, detail: [plain("No machine is online.")] };

  const running = online.reduce((sum, machine) => sum + machine.running, 0);
  const waiting = online.reduce((sum, machine) => sum + machine.waiting, 0);
  const room = online.reduce((sum, machine) => sum + countRoom(machine), 0);
  const detail: readonly FleetLeadPart[] = [
    number(running),
    plain(` ${plural(running, "session", "sessions")} running on `),
    number(online.length),
    plain(` ${plural(online.length, "machine", "machines")}`),
    ...(waiting > 0 ? [plain(", "), number(waiting), plain(" waiting")] : []),
    plain(". "),
    ...(room > 0
      ? [plain("Room for "), number(room), plain(" more right now.")]
      : [plain("No room right now.")]),
  ];
  return { headline, detail };
};

/**
 * Describes how much room a machine has. `room` is `countRoom`. `short` is
 * the text of a card or a list row ("Room for 4", "Full", "Takes no new
 * work"). `line` is the machine page's sentence about it. Both are `null`
 * while the machine is offline or unreachable, because the screen shows that
 * state instead.
 *
 * When the disk is below its limit and the machine is also set to take no new
 * work, the line names the disk, because that is the one the user can fix by
 * cleaning up.
 */
export const describeRoom = (
  machine: FleetMachine,
): { readonly room: number; readonly short: string | null; readonly line: string | null } => {
  const { runner } = machine;
  const room = countRoom(machine);
  if (runner.connectivity !== "online") return { room, short: null, line: null };

  const cap = runner.maxConcurrentSessions;
  if (isDiskBelowLimit(runner)) {
    return {
      room,
      short: "Takes no new work",
      line: "No room: its disk is below its limit, so it takes no new sessions",
    };
  }
  if (runner.lifecycle === "draining") {
    return { room, short: "Takes no new work", line: "No room: it takes no new work" };
  }
  if (room === 0) {
    return {
      room,
      short: "Full",
      line: `No room: it runs its cap of ${String(cap)} ${plural(cap, "session", "sessions")}`,
    };
  }
  return {
    room,
    short: `Room for ${String(room)}`,
    line: `Room for ${String(room)} more, under its cap of ${String(cap)}`,
  };
};

/** The most slots drawn one block each. A higher cap is drawn as one bar. */
const MAX_BLOCKS_CAP = 16;

/**
 * How to draw a machine's sessions against its cap. `blocks` is one block per
 * slot, `bar` is one bar cut every 10 sessions. `running` slots are filled,
 * `free` slots are empty, and `waiting` is one marigold block per session
 * after the cap. The drawn total is `max(cap, running) + waiting`: after the
 * user lowers the cap below the sessions running, `free` is 0 and `running`
 * runs past the cap. The renderer needs `cap` to mark where the cap ends.
 */
export interface SessionsDrawing {
  readonly shape: "blocks" | "bar";
  readonly cap: number;
  readonly running: number;
  readonly free: number;
  readonly waiting: number;
}

/**
 * Returns the counts to draw a machine's sessions from: blocks while the cap
 * is at most 16, a bar above. It takes the machine rather than three numbers
 * so the card cannot pass the counts in the wrong order. A machine running
 * more sessions than its cap (the cap was lowered) has 0 free slots, never a
 * negative number.
 */
export const drawSessions = (machine: FleetMachine): SessionsDrawing => {
  const cap = machine.runner.maxConcurrentSessions;
  return {
    shape: cap <= MAX_BLOCKS_CAP ? "blocks" : "bar",
    cap,
    running: machine.running,
    free: Math.max(0, cap - machine.running),
    waiting: machine.waiting,
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
 * Formats a size in bytes the way Finder does, in units of 10^9 bytes:
 * "420 MB" under a gigabyte, "10.7 GB" with one decimal under 100 GB, and
 * whole gigabytes from 100 GB with a thousands separator from 1,000 GB:
 * "245 GB", "1,953 GB". There is no terabyte unit. The tier is picked from the
 * rounded number, so 99.96 GB reads "100 GB" and not "100.0 GB".
 */
export const formatDiskSize = (bytes: number): string => {
  const megabytes = Math.round(bytes / 1e6);
  if (megabytes < 1000) return `${String(megabytes)} MB`;
  const gigabytes = bytes / 1e9;
  const tenths = Math.round(gigabytes * 10) / 10;
  if (tenths < 100) return `${tenths.toFixed(1)} GB`;
  return `${Math.round(gigabytes).toLocaleString("en-US")} GB`;
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
export const measureMemory = (
  runner: Runner,
): { readonly share: number; readonly level: GaugeLevel } | null => {
  if (runner.facts === null || runner.watermark === null) return null;
  const total = runner.facts.totalMemoryBytes;
  if (total <= 0) return null;
  const share = Math.min(1, Math.max(0, (total - runner.watermark.availableMemoryBytes) / total));
  const level = share >= MEMORY_FAIL_FROM ? "fail" : share >= MEMORY_YOU_FROM ? "you" : "normal";
  return { share, level };
};

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
): { readonly tone: "online" | "offline" | "draining"; readonly word: string | null } => {
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
