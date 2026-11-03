/**
 * What `fleet.ts` and `machine-page.ts` both need to know about one machine:
 * the runner joined with the counts of its sessions, how much room it has,
 * what it needs from the user, its status, its kind and when it was last seen.
 *
 * This file is private to the Fleet modules. It is not a package subpath, and
 * the two modules re-export the types their callers need.
 *
 * `today` is a parameter of every function that words a time ("Offline since
 * 09:12"). It is any instant on the user's current calendar day, never the
 * current instant: a time is worded relative to today only through its date
 * ("09:12" today, the weekday within a week, the date after that). A caller can
 * therefore pass the start of the day, and the words change only at midnight.
 */
import type { Runner, RunnerFacts } from "@hercule/contract";
import { formatShortMoment } from "../time-context";

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

export const NO_SESSIONS: RunnerSessionCounts = {
  running: 0,
  waiting: 0,
  waitingThreads: 0,
  openThreads: 0,
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

export const plural = (count: number, one: string, many: string): string =>
  count === 1 ? one : many;

/**
 * A piece of a sentence the Fleet screen builds, such as the lead or a
 * machine's room line. A renderer draws `count` in the "you" ink (the number
 * of machines that need the user), `number` in bold, `code` as code, and
 * `plain` as is.
 */
export interface FleetTextPart {
  readonly text: string;
  readonly kind: "plain" | "count" | "number" | "code";
}

export const buildPlainPart = (text: string): FleetTextPart => ({ text, kind: "plain" });
export const buildNumberPart = (value: number): FleetTextPart => ({
  text: String(value),
  kind: "number",
});

/**
 * Formats when the runner was last heard from, as short as a card allows
 * ("09:12" today, "Mon 09:12" within a week, "4 Nov 09:12" before that), in
 * `timezone`. Returns `null` when the runner was never seen or the time
 * cannot be formatted.
 */
export const formatLastSeen = (runner: Runner, timezone: string, today: Date): string | null => {
  if (runner.lastSeenAt === null) return null;
  return formatShortMoment(new Date(runner.lastSeenAt), today, timezone) ?? null;
};

/**
 * Checks whether the machine's free disk is below its disk limit, which is
 * when the controller places no new session on it. Equal is not below. False
 * when the runner has not reported its disk yet.
 */
export const isDiskBelowLimit = (runner: Runner): boolean =>
  runner.metrics !== null && runner.metrics.diskFreeBytes < runner.diskWatermarkBytes;

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
export const countRoom = (machine: FleetMachine): number =>
  canTakeNewSessions(machine.runner)
    ? Math.max(0, machine.runner.maxConcurrentSessions - machine.running)
    : 0;

/**
 * Describes how much room an online machine has. `short` is the text of a card
 * or a list row ("Room for 4" or "Full"). `line` is the machine page's
 * sentence about it, in parts so the number can be drawn in bold. Returns
 * `null` while the machine is offline or unreachable, because the screen shows
 * that state instead.
 *
 * - `short` is `null` while the machine is told to take no new work, because
 *   its status label already says so, and while its disk is below its limit,
 *   because the line of what needs the user already says so.
 * - When the disk is below its limit and the machine is also set to take no
 *   new work, the line names the disk, because that is the one the user can
 *   fix by cleaning up.
 */
export const describeRoom = (
  machine: FleetMachine,
): { readonly short: string | null; readonly line: readonly FleetTextPart[] } | null => {
  const { runner } = machine;
  if (runner.connectivity !== "online") return null;

  const room = countRoom(machine);
  const cap = runner.maxConcurrentSessions;
  if (isDiskBelowLimit(runner)) {
    return {
      short: null,
      line: [buildPlainPart("No room: its disk is below its limit, so it takes no new sessions")],
    };
  }
  if (runner.lifecycle === "draining") {
    return { short: null, line: [buildPlainPart("No room: it takes no new work")] };
  }
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

/** Words an unreachable machine: "Not heard from since 09:12", or "Unreachable" when it was never seen. */
const describeUnreachable = (seen: string | null): string =>
  seen === null ? "Unreachable" : `Not heard from since ${seen}`;

/**
 * The status dot of a machine and the text beside it. `tone` is the dot:
 * `offline` for an offline or unreachable runner, `draining` for an online
 * runner told to take no new work, else `online`. `label` is "Online",
 * "Offline", "Not heard from since 09:12" (unreachable, or "Unreachable" when
 * it was never seen) or "Takes no new work". An offline machine is "Offline"
 * even when it is also draining.
 */
export interface MachineStatus {
  readonly tone: "online" | "offline" | "draining";
  readonly label: string;
}

/** Describes the status of `runner`. See `MachineStatus`. */
export const describeMachineStatus = (
  runner: Runner,
  timezone: string,
  today: Date,
): MachineStatus => {
  if (runner.connectivity === "offline") return { tone: "offline", label: "Offline" };
  if (runner.connectivity === "unreachable") {
    return {
      tone: "offline",
      label: describeUnreachable(formatLastSeen(runner, timezone, today)),
    };
  }
  if (runner.lifecycle === "draining") return { tone: "draining", label: "Takes no new work" };
  return { tone: "online", label: "Online" };
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

/** The most slots, and the most waiting sessions, drawn one block each. */
const MAX_BLOCKS = 16;

/**
 * How to draw a machine's sessions against its cap, and the words drawn beside
 * it. `blocks` is one block per slot, `bar` is one bar cut every 10 sessions.
 * `running` slots are filled, `free` slots are empty, and `waiting` is the
 * number of sessions waiting for a slot, drawn as marigold after the cap. The
 * drawn total is `max(cap, running) + waiting`: after the user lowers the cap
 * below the sessions running, `free` is 0 and `running` runs past the cap. The
 * renderer needs `cap` to mark where the cap ends in that case, and where the
 * waiting part starts.
 *
 * `waitingBlocks` is how many waiting blocks the `blocks` shape draws: at most
 * 16, because the drawing is clipped to its place anyway and the text beside it
 * carries the count. It is 0 for a `bar`, which draws one stretch for all of
 * `waiting`.
 *
 * A machine that is `isAway` (offline or unreachable) runs nothing that can be
 * counted: `running` is 0 and every slot is `free`, and the renderer draws the
 * cap as an outline. Its `waiting` sessions stay, because the controller still
 * knows what waits for the machine.
 */
export interface SessionsDrawing {
  readonly shape: "blocks" | "bar";
  readonly cap: number;
  readonly running: number;
  readonly free: number;
  readonly waiting: number;
  readonly waitingBlocks: number;
  readonly isAway: boolean;
  /** The sessions running as text: "12", or "–" while the machine is away. */
  readonly runningText: string;
  /** The cap, to read after `runningText`: " of 16". */
  readonly capText: string;
  /** "5 waiting", or `null` while no session waits. */
  readonly waitingText: string | null;
}

/**
 * Returns the counts and words to draw a machine's sessions from: blocks while
 * both the cap and the sessions running are at most 16, a bar otherwise. A cap
 * lowered from 100 to 4 under 100 running sessions is therefore a bar, not 100
 * blocks. A machine running more sessions than its cap has 0 free slots, never
 * a negative number. An away machine counts as running none (see
 * `SessionsDrawing`).
 */
export const buildSessionsDrawing = (machine: FleetMachine): SessionsDrawing => {
  const { runner, waiting } = machine;
  const isAway = runner.connectivity !== "online";
  const cap = runner.maxConcurrentSessions;
  const running = isAway ? 0 : machine.running;
  const shape = cap <= MAX_BLOCKS && running <= MAX_BLOCKS ? "blocks" : "bar";
  return {
    shape,
    cap,
    running,
    free: Math.max(0, cap - running),
    waiting,
    waitingBlocks: shape === "blocks" ? Math.min(waiting, MAX_BLOCKS) : 0,
    isAway,
    runningText: isAway ? "–" : String(running),
    capText: ` of ${String(cap)}`,
    waitingText: waiting > 0 ? `${String(waiting)} waiting` : null,
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
export const splitDiskSize = (
  bytes: number,
): { readonly amount: string; readonly unit: "MB" | "GB" } => {
  const megabytes = Math.round(bytes / 1e6);
  if (megabytes < 1000) return { amount: String(megabytes), unit: "MB" };
  const gigabytes = bytes / 1e9;
  const tenths = Math.round(gigabytes * 10) / 10;
  if (tenths < 100) return { amount: tenths.toFixed(1), unit: "GB" };
  return { amount: Math.round(gigabytes).toLocaleString("en-US"), unit: "GB" };
};

/** How full a gauge is: `normal`, `you` (getting high), or `fail` (too high). */
export type GaugeLevel = "normal" | "you" | "fail";

const MEMORY_YOU_FROM_PERCENT = 80;
const MEMORY_FAIL_FROM_PERCENT = 92;
const DISK_YOU_FROM_PERCENT = 85;

/**
 * Measures how much of `totalBytes` is `usedBytes`, which is clamped to the
 * total first, so `freeBytes` is never negative or above the total. `share`
 * is the fill from 0 to 1. `percent` is the whole number shown beside a gauge,
 * rounded down.
 *
 * It rounds down, never to the nearest, and the levels below compare that
 * same whole percent. A gauge that turns `you` at 85% must never show a
 * normal-coloured "85%", which rounding 84.6 up would: 84.6% shows "84%" and
 * is normal. The percent is computed from whole bytes before dividing, because
 * multiplying a share by 100 can land just under a whole number (0.29 * 100 is
 * 28.999999999999996) and round down to the wrong one.
 */
const measureUse = (
  usedBytes: number,
  totalBytes: number,
): { readonly share: number; readonly percent: number; readonly freeBytes: number } => {
  const used = Math.min(totalBytes, Math.max(0, usedBytes));
  return {
    share: used / totalBytes,
    percent: Math.floor((used * 100) / totalBytes),
    freeBytes: totalBytes - used,
  };
};

/** How much of a machine's memory is in use. See `measureMemory`. */
export interface MemoryMeasure {
  readonly share: number;
  readonly percent: number;
  readonly level: GaugeLevel;
  readonly freeBytes: number;
  readonly totalBytes: number;
}

/**
 * Measures the memory in use on a machine: `share` is the part of its RAM
 * that is not available, from 0 to 1, `percent` is that share rounded down
 * (see `measureUse`), and `level` is `you` from 80% and `fail` from 92%.
 * `freeBytes` is the available memory, capped at `totalBytes`, the machine's
 * RAM. Returns `null` when the runner has not reported its total memory or
 * its available memory. A high level is only a colour: memory never makes a
 * machine need the user.
 */
export const measureMemory = (runner: Runner): MemoryMeasure | null => {
  if (runner.facts === null || runner.metrics === null) return null;
  const total = runner.facts.totalMemoryBytes;
  if (total <= 0) return null;
  const { share, percent, freeBytes } = measureUse(
    total - runner.metrics.availableMemoryBytes,
    total,
  );
  const level =
    percent >= MEMORY_FAIL_FROM_PERCENT
      ? "fail"
      : percent >= MEMORY_YOU_FROM_PERCENT
        ? "you"
        : "normal";
  return { share, percent, level, freeBytes, totalBytes: total };
};

/** How much of a machine's disk is in use. See `measureDisk`. */
export interface DiskMeasure {
  readonly freeBytes: number;
  readonly level: GaugeLevel;
  /** How full the disk is, or `null` when the runner did not report the disk's total size. */
  readonly use: {
    readonly totalBytes: number;
    readonly share: number;
    readonly percent: number;
  } | null;
}

/**
 * Measures the disk of a machine. `freeBytes` is the free space, capped at the
 * total when there is one. `use` says how full the disk is (see `measureUse`),
 * and is `null` when the runner did not report the disk's total size. `level`
 * is `fail` while the free space is below the disk limit, even without a total,
 * else `you` from 85% full, else `normal`. Returns `null` when the runner has
 * not reported its disk.
 */
export const measureDisk = (runner: Runner): DiskMeasure | null => {
  if (runner.metrics === null) return null;
  const { diskFreeBytes } = runner.metrics;
  const decideLevel = (percent: number | null): GaugeLevel =>
    isDiskBelowLimit(runner)
      ? "fail"
      : percent !== null && percent >= DISK_YOU_FROM_PERCENT
        ? "you"
        : "normal";
  const total = runner.facts?.diskTotalBytes;
  if (total === undefined || total <= 0) {
    return { freeBytes: diskFreeBytes, level: decideLevel(null), use: null };
  }
  const { share, percent, freeBytes } = measureUse(total - diskFreeBytes, total);
  return { freeBytes, level: decideLevel(percent), use: { totalBytes: total, share, percent } };
};

const BYTES_PER_GIBIBYTE = 1024 ** 3;

/** Formats a memory size in binary gigabytes, rounded to a whole number: "64". */
export const formatWholeMemory = (bytes: number): string =>
  String(Math.round(bytes / BYTES_PER_GIBIBYTE));

/**
 * Formats a byte count in binary gigabytes with one decimal under 100 and
 * whole from there on, as the disk sizes do: "17.6", "120".
 */
const formatGibibytes = (bytes: number): string => {
  const gibibytes = bytes / BYTES_PER_GIBIBYTE;
  const tenths = Math.round(gibibytes * 10) / 10;
  return tenths < 100 ? tenths.toFixed(1) : Math.round(gibibytes).toLocaleString("en-US");
};

/**
 * What a gauge of the Fleet draws: a big number with a unit after it, and a
 * meter. Every screen draws the same gauge from the same `MachineGauge`.
 */
export interface MachineGauge {
  /**
   * The big number: the percentage in use ("87"); the free space ("21.5")
   * while the disk's total size is unknown; "–" while the machine reported
   * nothing for the gauge.
   */
  readonly value: string;
  /** What follows `value`: "%", " GB free", or "" when `value` is "–". */
  readonly unit: string;
  /**
   * The free space as a size ("69.8 GB"), or "" for a gauge with no free space
   * to name: nothing reported yet, or the CPU.
   */
  readonly freeAmount: string;
  /** How far the meter is filled, from 0 to 1. `null` draws it empty. */
  readonly share: number | null;
  /** Colours the number and the meter. */
  readonly level: GaugeLevel;
}

/** The gauge of a resource the runner has reported nothing for. */
export const NOT_REPORTED_GAUGE: MachineGauge = {
  value: "–",
  unit: "",
  freeAmount: "",
  share: null,
  level: "normal",
};

/** Describes a gauge that shows how full a resource is, as a whole percentage. */
const describeFullnessGauge = (
  use: { readonly share: number; readonly percent: number },
  level: GaugeLevel,
  freeAmount: string,
): MachineGauge => ({
  value: String(use.percent),
  unit: "%",
  freeAmount,
  share: use.share,
  level,
});

/** Describes the memory gauge of a machine from its `memory` measure, in binary gigabytes. */
export const describeMemoryGauge = (memory: MemoryMeasure | null): MachineGauge =>
  memory === null
    ? NOT_REPORTED_GAUGE
    : describeFullnessGauge(memory, memory.level, `${formatGibibytes(memory.freeBytes)} GB`);

/**
 * Describes the disk gauge of a machine from its `disk` measure, in gigabytes
 * of 10^9 bytes. Without the disk's total size there is no percentage, so the
 * gauge shows the free space and an empty meter.
 */
export const describeDiskGauge = (disk: DiskMeasure | null): MachineGauge => {
  if (disk === null) return NOT_REPORTED_GAUGE;
  const free = splitDiskSize(disk.freeBytes);
  const freeAmount = `${free.amount} ${free.unit}`;
  if (disk.use === null) {
    return {
      value: free.amount,
      unit: ` ${free.unit} free`,
      freeAmount,
      share: null,
      level: disk.level,
    };
  }
  return describeFullnessGauge(disk.use, disk.level, freeAmount);
};

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
    }
  | { readonly kind: "disk-nearly-full"; readonly hue: "you"; readonly line: string };

const describeWaiting = ({ waiting, waitingThreads }: FleetMachine): string => {
  const noun = waitingThreads === waiting ? "thread" : "session";
  return waiting === 1
    ? `1 ${noun} waits for a slot`
    : `${String(waiting)} ${noun}s wait for a slot`;
};

const describeAllowHint = ({ running, waiting }: FleetMachine): string => {
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
 * slot, its disk is 85% full or more. The list is empty when the machine needs
 * nothing. A time is worded relative to `today` in `timezone`, and left out
 * when the runner was never seen.
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
 *
 * The needs are independent of each other: a machine can have several.
 */
export const listMachineNeeds = (
  machine: FleetMachine,
  timezone: string,
  today: Date,
): readonly MachineNeed[] => {
  const { runner } = machine;
  const needs: MachineNeed[] = [];
  const seen = formatLastSeen(runner, timezone, today);
  if (runner.connectivity === "offline") {
    needs.push({
      kind: "offline",
      hue: "fail",
      line: seen === null ? "Offline" : `Offline since ${seen}`,
    });
  }
  if (runner.connectivity === "unreachable") {
    needs.push({ kind: "unreachable", hue: "fail", line: describeUnreachable(seen) });
  }
  if (isDiskBelowLimit(runner)) {
    needs.push({
      kind: "disk-below-limit",
      hue: "fail",
      line: "Disk below its limit. It takes no new sessions.",
    });
  }
  const isCapHoldingSessionsBack =
    canTakeNewSessions(runner) &&
    machine.waiting > 0 &&
    machine.running + machine.waiting > runner.maxConcurrentSessions;
  if (isCapHoldingSessionsBack) {
    needs.push({
      kind: "waiting",
      hue: "you",
      line: describeWaiting(machine),
      allow: machine.running + machine.waiting,
      allowHint: describeAllowHint(machine),
    });
  }
  // A disk without a reported total size has no percentage, so it is never "nearly full".
  const diskPercent = measureDisk(runner)?.use?.percent;
  if (diskPercent !== undefined && diskPercent >= DISK_YOU_FROM_PERCENT) {
    needs.push({ kind: "disk-nearly-full", hue: "you", line: `Disk ${String(diskPercent)}% full` });
  }
  return needs;
};
