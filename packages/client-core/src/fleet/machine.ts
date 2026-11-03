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
 * slot. The list is empty when the machine needs nothing. A time is worded
 * relative to `today` in `timezone`, and left out when the runner was never
 * seen.
 */
export const listMachineNeeds = (
  machine: FleetMachine,
  timezone: string,
  today: Date,
): readonly MachineNeed[] => {
  const seen = formatLastSeen(machine.runner, timezone, today);
  return listNeedKinds(machine).map((kind): MachineNeed => {
    switch (kind) {
      case "offline":
        return { kind, hue: "fail", line: seen === null ? "Offline" : `Offline since ${seen}` };
      case "unreachable":
        return { kind, hue: "fail", line: describeUnreachable(seen) };
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
