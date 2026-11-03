/**
 * The pure logic of one machine's page on the desktop Fleet screen: its head,
 * the room line or the offline banner under it, the Software rows, and the
 * parsing of the Settings fields. No function here reads a clock or a store;
 * the caller passes the records and `today` (see `fleet.ts` for what `today`
 * is).
 *
 * This module is its own subpath (`@hercule/client-core/machine-page`) and is
 * not re-exported from the package index, so the first screen does not carry
 * it.
 */
import {
  MAX_RUNNER_LABEL_LENGTH,
  MAX_RUNNER_LABELS,
  type Harness,
  type Provider,
  type ProviderAccount,
  type Runner,
  type RunnerFacts,
} from "@hercule/contract";
import { listProviderAccountMachines } from "../provider-account-machines";
import { buildProviderAccountName } from "../provider-accounts";
import { parseWholeNumber } from "../whole-number";
import {
  buildFleetMachine,
  buildPlainPart,
  buildSessionsDrawing,
  decideMachineKind,
  describeMachineStatus,
  describeRoom,
  formatLastSeen,
  describeDiskGauge,
  describeMemoryGauge,
  formatWholeMemory,
  measureDisk,
  measureMemory,
  NOT_REPORTED_GAUGE,
  splitDiskSize,
  type FleetMachine,
  type FleetTextPart,
  type GaugeLevel,
  type MachineGauge,
  type MachineKind,
  type MachineStatus,
  type SessionCountsByRunner,
  type SessionsDrawing,
} from "./machine";

/** A release version: three numbers, with optional build metadata after a plus. */
const RELEASE_VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Checks whether the runner runs an older release than its controller, which
 * is when a runner can be updated to the controller's version.
 *
 * A version is read as major, minor and patch, and the build metadata after a
 * plus sign is ignored, as semantic versioning says. Returns false when either
 * version is missing or is not that shape (a pre-release such as
 * "0.9.3-rc.1"), because then no order is known and the page must not guess.
 */
const isRunnerBehind = (runnerVersion: string | null, controllerVersion: string): boolean => {
  if (runnerVersion === null) return false;
  const runner = RELEASE_VERSION.exec(runnerVersion);
  const controller = RELEASE_VERSION.exec(controllerVersion);
  if (runner === null || controller === null) return false;
  for (const index of [1, 2, 3]) {
    const difference = Number(controller[index]) - Number(runner[index]);
    if (difference !== 0) return difference > 0;
  }
  return false;
};

// A Map, not an object: the operating system is text the runner reported, and
// an object would answer "__proto__" or "constructor" with a value of its own.
const OS_NAMES: ReadonlyMap<string, string> = new Map([
  ["darwin", "macOS"],
  ["linux", "Linux"],
  ["win32", "Windows"],
]);

/**
 * Describes a machine for the head of its page, as the pieces drawn between
 * dots: the operating system's name, the architecture as the runner reported
 * it, the memory, and the disk's size when the runner reported it, such as
 * "macOS", "arm64", "64 GB memory", "1,000 GB disk". An operating system the
 * table does not know is shown as the runner reported it.
 *
 * The memory is counted in binary gigabytes (2^30 bytes), the way Apple's
 * About This Mac and Activity Monitor count it, and rounded to a whole number.
 * The disk follows Finder instead, which counts in units of 10^9 bytes; each
 * is the number its own tool shows the user.
 */
const describeMachineFacts = (facts: RunnerFacts): readonly string[] => {
  const disk = facts.diskTotalBytes === undefined ? null : splitDiskSize(facts.diskTotalBytes);
  return [
    OS_NAMES.get(facts.os) ?? facts.os,
    facts.arch,
    `${formatWholeMemory(facts.totalMemoryBytes)} GB memory`,
    ...(disk === null ? [] : [`${disk.amount} ${disk.unit} disk`]),
  ];
};

/**
 * The banner an offline or unreachable machine shows. `headline` is its first
 * sentence. `detail` holds the rest, with the command to start the machine
 * again as a `code` part. Read in order, the headline and the detail are the
 * spec's sentence.
 */
export interface OfflineBanner {
  readonly headline: string;
  readonly detail: readonly FleetTextPart[];
}

/**
 * Builds the offline banner of a machine: when it was last heard from, what
 * may have happened, how many threads wait for it, and how to start it again.
 *
 * - The `openThreads` are the Threads that carry on once it is back. The
 *   sentence about them is left out at 0.
 * - A runner never heard from has no time to name: the banner says it has not
 *   been heard from, and drops the closing sentence that dates what the page
 *   shows.
 */
const describeOfflineBanner = (
  runner: Runner,
  openThreads: number,
  timezone: string,
  today: Date,
): OfflineBanner => {
  const seen = formatLastSeen(runner, timezone, today);
  const threads =
    openThreads === 0
      ? ""
      : ` Its ${String(openThreads)} ${openThreads === 1 ? "thread" : "threads"} can carry on once it is back, and work waiting for it starts then.`;
  return {
    headline:
      seen === null
        ? `${runner.name} has not been heard from.`
        : `${runner.name} has not been heard from since ${seen}.`,
    detail: [
      buildPlainPart(
        `It may be asleep, off the network, or without power.${threads} If it does not come back by itself, start Hercule on it again: `,
      ),
      { text: "hercule service start", kind: "code" },
      buildPlainPart(seen === null ? "." : `. What you see below is from ${seen}.`),
    ],
  };
};

/** The head of a machine's page: its icon, name, status and the facts the runner reported. */
export interface MachineHead {
  readonly name: string;
  /** The machine's icon. */
  readonly kind: MachineKind;
  readonly status: MachineStatus;
  /**
   * The operating system, the architecture, the memory and the disk's size,
   * such as "macOS", "arm64", "16 GB memory" and "1,000 GB disk"; the disk is
   * left out when the runner does not report it, and all of it before the
   * runner has reported its facts.
   */
  readonly facts: readonly string[];
  /** The runner program's own line, or `null` when the runner reported no version. */
  readonly runner: {
    /** Such as "Runner 0.9.3". */
    readonly text: string;
    /** "update available" while the controller runs a newer release, else `null`. */
    readonly updateText: string | null;
  } | null;
}

/**
 * What a machine's page draws under its head. An online machine shows its room
 * line; a machine that is offline or unreachable shows the banner instead.
 */
export type MachinePageTop =
  | { readonly kind: "room"; readonly line: readonly FleetTextPart[] }
  | { readonly kind: "away"; readonly banner: OfflineBanner };

/**
 * An instrument drawn as a meter: the gauge, and the line under the meter. A
 * renderer draws it as the Fleet cards draw the same gauge.
 */
export interface MeterInstrument extends MachineGauge {
  /** The line under the meter. */
  readonly note: string;
}

/**
 * The Sessions instrument: how many sessions run against the cap, and how many
 * wait. It has no meter, but the same blocks or bar a card shows, from
 * `drawing`, which also holds the texts of `value` and `unit`.
 */
export interface SessionsInstrument {
  /** The sessions running: "12", or "–" while the machine is away. */
  readonly value: string;
  /** The cap, such as " of 16". An away machine keeps it beside the "–". */
  readonly unit: string;
  /** Colours the number: `you` while sessions wait on a machine that is online. */
  readonly level: GaugeLevel;
  /** The line under the drawing: "5 waiting" or "None waiting". */
  readonly note: string;
  readonly drawing: SessionsDrawing;
}

/** The four instruments of a machine's page, with the latest values. */
export interface MachineInstruments {
  readonly sessions: SessionsInstrument;
  readonly cpu: MeterInstrument;
  readonly memory: MeterInstrument;
  readonly disk: MeterInstrument;
}

/** The line under an instrument that has no report to show yet. */
const NOT_REPORTED_NOTE = "Not reported yet";

/** The line under the CPU of a runner whose reports carry none. */
const CPU_TOO_OLD_NOTE = "This machine's runner is too old to report CPU. Update it.";

/** The line under the disk of a runner that does not report the disk's total size. */
const DISK_TOTAL_MISSING_NOTE =
  "This machine's runner does not report its disk size. Update it to see how full the disk is.";

const NOT_REPORTED: MeterInstrument = { ...NOT_REPORTED_GAUGE, note: NOT_REPORTED_NOTE };

/** Describes the instrument of the CPU: the last minute's mean and peak, floored. See `describeMachineInstruments`. */
const describeCpuInstrument = (runner: Runner): MeterInstrument => {
  if (runner.metrics === null) return NOT_REPORTED;
  const { cpu } = runner.metrics;
  if (cpu === undefined) {
    return {
      ...NOT_REPORTED,
      note: CPU_TOO_OLD_NOTE,
    };
  }
  if (cpu === null) return { ...NOT_REPORTED, note: "First reading within a minute" };
  return {
    value: String(Math.floor(cpu.averagePercent)),
    unit: "%",
    freeAmount: "",
    level: "normal",
    share: cpu.averagePercent / 100,
    note: `Peak ${String(Math.floor(cpu.peakPercent))}% in the last minute`,
  };
};

/** Describes the instrument of memory: the share in use and the memory free. See `describeMachineInstruments`. */
const describeMemoryInstrument = (runner: Runner): MeterInstrument => {
  const memory = measureMemory(runner);
  if (memory === null) return NOT_REPORTED;
  const gauge = describeMemoryGauge(memory);
  return {
    ...gauge,
    note: `${gauge.freeAmount} free of ${formatWholeMemory(memory.totalBytes)} GB`,
  };
};

/** Describes the instrument of the disk: the share in use and the space free. See `describeMachineInstruments`. */
const describeDiskInstrument = (runner: Runner): MeterInstrument => {
  const disk = measureDisk(runner);
  if (disk === null) return NOT_REPORTED;
  const gauge = describeDiskGauge(disk);
  if (disk.use === null) {
    return {
      ...gauge,
      note: DISK_TOTAL_MISSING_NOTE,
    };
  }
  const size = splitDiskSize(disk.use.totalBytes);
  return { ...gauge, note: `${gauge.freeAmount} free of ${size.amount} ${size.unit}` };
};

/**
 * Describes the four instruments of a machine from the runner's latest report.
 * An away machine keeps the values it last reported. Before any report, CPU,
 * memory and disk show "–" and "Not reported yet".
 *
 * - Sessions: how many run, against the cap, and how many wait. It is `you`
 *   while sessions wait. A machine that is offline or unreachable runs
 *   nothing that can be counted, so the number is "–" against the cap, as on
 *   its card, and the level is `normal`. The controller still knows what
 *   waits for the machine, so the note keeps that count.
 * - CPU: the last minute's mean, floored, with the peak. It has no colour
 *   levels. A runner that reports no CPU, or none yet, says so in the note.
 * - Memory: the share in use, floored, and the memory free of the total, in
 *   binary gigabytes.
 * - Disk: the share in use, floored, and the free space of the total, in
 *   gigabytes of 10^9 bytes. Without the disk's total size it shows the free
 *   space with an empty meter and says to update the runner.
 */
const describeMachineInstruments = (machine: FleetMachine): MachineInstruments => {
  const { runner } = machine;
  const drawing = buildSessionsDrawing(machine);
  return {
    sessions: {
      value: drawing.runningText,
      unit: drawing.capText,
      level: drawing.waiting > 0 && !drawing.isAway ? "you" : "normal",
      note: drawing.waitingText ?? "None waiting",
      drawing,
    },
    cpu: describeCpuInstrument(runner),
    memory: describeMemoryInstrument(runner),
    disk: describeDiskInstrument(runner),
  };
};

/** Everything a machine's page draws above its Software and Settings. */
export interface MachinePage {
  readonly head: MachineHead;
  readonly top: MachinePageTop;
  readonly instruments: MachineInstruments;
}

/**
 * Builds the head and the room line or banner of the page of `runner`.
 * `counts` holds the session counts of the runners (the runner's own entry is
 * used; none means no sessions). `controllerVersion` is what the runner's
 * version is compared with. Times are worded in `timezone`, relative to
 * `today`.
 */
export const describeMachinePage = (
  runner: Runner,
  counts: SessionCountsByRunner,
  controllerVersion: string,
  timezone: string,
  today: Date,
): MachinePage => {
  const machine = buildFleetMachine(runner, counts);
  const room = describeRoom(machine);
  return {
    head: {
      name: runner.name,
      kind: decideMachineKind(runner.facts),
      status: describeMachineStatus(runner, timezone, today),
      facts: runner.facts === null ? [] : describeMachineFacts(runner.facts),
      runner:
        runner.version === null
          ? null
          : {
              text: `Runner ${runner.version}`,
              updateText: isRunnerBehind(runner.version, controllerVersion)
                ? "update available"
                : null,
            },
    },
    top:
      room === null
        ? {
            kind: "away",
            banner: describeOfflineBanner(runner, machine.openThreads, timezone, today),
          }
        : { kind: "room", line: room.line },
    instruments: describeMachineInstruments(machine),
  };
};

/** One harness on one machine, as the Software section draws it. */
export interface MachineHarnessRow {
  readonly harnessId: string;
  readonly name: string;
  readonly isInstalled: boolean;
  /** "Not installed", the version the machine reported, or "Installed" when it reported none. */
  readonly versionText: string;
  /**
   * What the version means against this Hercule build, or `null` when there
   * is nothing to say: `fail` for a version below the oldest this build
   * works with, `muted` for one newer than this build was tested with.
   */
  readonly note: { readonly text: string; readonly tone: "fail" | "muted" } | null;
}

/**
 * Builds one row per harness for the machine `runnerId`, in the order of
 * `harnesses`. A harness the machine has no entry for counts as not
 * installed. A version verdict only counts for an installed harness.
 */
export const listMachineHarnesses = (
  harnesses: readonly Harness[],
  runnerId: string,
): readonly MachineHarnessRow[] =>
  harnesses.map((harness) => {
    const onMachine = harness.runners.find((entry) => entry.runnerId === runnerId);
    const isInstalled = onMachine?.installed === true;
    const verdict = isInstalled ? onMachine.versionVerdict : "unknown";
    return {
      harnessId: harness.id,
      name: harness.displayName,
      isInstalled,
      versionText: isInstalled ? (onMachine.version ?? "Installed") : "Not installed",
      note:
        verdict === "below-floor"
          ? { text: "Too old for this Hercule: update it", tone: "fail" }
          : verdict === "above-tested-max"
            ? { text: "Newer than this Hercule was tested with", tone: "muted" }
            : null,
    };
  });

/** One Provider Account that signs in on each machine, as this machine's Software section draws it. */
export interface MachineAccountRow {
  readonly providerAccountId: string;
  readonly name: string;
  readonly harnessId: string;
  readonly harnessName: string;
  /** Who is signed in, or why nobody can be. */
  readonly text: string;
  /** `you` while the user can sign in, `faint` when no sign-in is possible here, else `muted`. */
  readonly tone: "muted" | "you" | "faint";
  /** Whether the row offers Sign in: the machine is online and has the harness. */
  readonly canSignIn: boolean;
}

/**
 * Builds one row per Provider Account that signs in on each machine, for the
 * machine `runner`. A key or token account is left out: it works on every
 * machine. Returns the rows in the order of `accounts`.
 *
 * Install is not offered here, so a machine that lacks the harness (or whose
 * build cannot run it) says so in the row's text instead.
 */
export const listMachineAccounts = (
  runner: Runner,
  accounts: readonly ProviderAccount[],
  providers: readonly Provider[],
  harnesses: readonly Harness[],
): readonly MachineAccountRow[] =>
  accounts.flatMap((account): MachineAccountRow[] => {
    const machine = listProviderAccountMachines(account, [runner], providers, harnesses)?.[0];
    if (machine === undefined) return [];
    const harnessName =
      harnesses.find((harness) => harness.id === account.defaultHarnessId)?.displayName ??
      account.defaultHarnessId;
    const row = {
      providerAccountId: account.id,
      name: buildProviderAccountName(providers, account),
      harnessId: account.defaultHarnessId,
      harnessName,
    };
    const { action } = machine;
    if (action === null) {
      const text = machine.identity === null ? "Signed in" : `Signed in as ${machine.identity}`;
      return [{ ...row, text, tone: "muted", canSignIn: false }];
    }
    switch (action.kind) {
      case "sign-in":
        return [{ ...row, text: "Not signed in", tone: "you", canSignIn: true }];
      case "install":
        return [
          { ...row, text: `Needs ${harnessName} on this machine`, tone: "faint", canSignIn: false },
        ];
      case "unavailable":
        return [{ ...row, text: action.reason, tone: "faint", canSignIn: false }];
      case "offline":
        return [{ ...row, text: "Not signed in", tone: "faint", canSignIn: false }];
    }
  });

/**
 * The outcome of checking text a user typed into a Settings field: the parsed
 * `value`, or a `refusal` that says what is wrong and what to do.
 */
export type ParsedField<Value> = { readonly value: Value } | { readonly refusal: string };

/** Parses the session cap a user typed: a whole number of at least 1, such as 8. */
export const parseSessionCap = (text: string): ParsedField<number> => {
  const cap = parseWholeNumber(text);
  return cap !== undefined && cap >= 1 && Number.isSafeInteger(cap)
    ? { value: cap }
    : { refusal: "The session cap must be a whole number of 1 or more, such as 8." };
};

const BYTES_PER_GIGABYTE = 1e9;

/** A number of gigabytes with at most one decimal, such as "12" or "12.5". */
const GIGABYTES = /^\d+(?:\.\d)?$/;

/**
 * Parses the disk limit a user typed, in gigabytes of 10^9 bytes, and returns
 * its value in bytes. The text holds a number with at most one decimal. Anything
 * else is refused, and so is a limit of 0, which would never stop a machine
 * from taking work.
 */
export const parseDiskLimit = (text: string): ParsedField<number> => {
  const trimmed = text.trim();
  const bytes = GIGABYTES.test(trimmed) ? Math.round(Number(trimmed) * BYTES_PER_GIGABYTE) : 0;
  return bytes >= 1 && Number.isSafeInteger(bytes)
    ? { value: bytes }
    : {
        refusal:
          "The disk limit must be a number of gigabytes with at most one decimal, such as 10 or 12.5.",
      };
};

/**
 * Formats a disk limit in bytes as the gigabytes the field shows: one decimal
 * of 10^9 bytes, without a trailing ".0". The default limit of 10 GiB reads
 * "10.7".
 *
 * That text is rounded, so it does not return to the stored bytes through
 * `parseDiskLimit`. A field must therefore save only when the user changed
 * the text, never when it merely lost focus.
 */
export const formatDiskLimit = (bytes: number): string => {
  const gigabytes = (bytes / BYTES_PER_GIGABYTE).toFixed(1);
  return gigabytes.endsWith(".0") ? gigabytes.slice(0, -2) : gigabytes;
};

/** A change to a machine's labels: one label added, or one removed. */
export type LabelChange =
  | { readonly kind: "add"; readonly label: string }
  | { readonly kind: "remove"; readonly label: string };

/**
 * Returns the labels after `change`. Adding a label the machine already has
 * changes nothing, so the order of the labels is kept and none repeats.
 */
export const changeRunnerLabels = (
  labels: readonly string[],
  change: LabelChange,
): readonly string[] => {
  if (change.kind === "remove") return labels.filter((label) => label !== change.label);
  return labels.includes(change.label) ? labels : [...labels, change.label];
};

/**
 * Checks a label a user typed against the machine's `labels`. Returns the
 * label without spaces around it as the `value`, or a `refusal` that says
 * what is wrong and what to do. Empty text is not a label and not an error: it
 * returns `undefined`, so an empty field just closes.
 *
 * The limits are the contract's: at most 64 characters a label and 64 labels.
 */
export const validateRunnerLabel = (
  text: string,
  labels: readonly string[],
): ParsedField<string> | undefined => {
  const label = text.trim();
  if (label === "") return undefined;
  if (label.length > MAX_RUNNER_LABEL_LENGTH) {
    return {
      refusal: `A label can have at most ${String(MAX_RUNNER_LABEL_LENGTH)} characters. Use a shorter one.`,
    };
  }
  if (labels.includes(label)) {
    return { refusal: `This machine already has the label "${label}".` };
  }
  if (labels.length >= MAX_RUNNER_LABELS) {
    return {
      refusal: `A machine can have at most ${String(MAX_RUNNER_LABELS)} labels. Remove one first.`,
    };
  }
  return { value: label };
};
