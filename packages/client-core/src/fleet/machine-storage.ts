/**
 * The pure logic of the Storage section on a machine's page of the desktop
 * Fleet screen (spec 17 §A machine's page point 5): the head with the free
 * space and the forecast, the disk as one bar in parts, the line on automatic
 * cleanup, the largest idle workspaces and the state of the Clean up…
 * button. No function here reads a clock or a store.
 *
 * This module is its own subpath (`@hercule/client-core/machine-storage`) and
 * is not re-exported from the package index, so the first screen does not
 * carry it.
 */
import {
  DISK_USAGE_CAPABILITY,
  type Event,
  type Runner,
  type RunnerMetricsPoint,
  type Session,
  type Workspace,
} from "@hercule/contract";
import { formatDayStamp } from "../time-context";
import {
  buildIdleWorkspaceRows,
  formatDiskSize,
  isIdleWorkspace,
  listCleanupCandidates,
  type IdleWorkspaceRow,
} from "./cleanup";
import { forecastDiskLimit } from "./disk-forecast";
import { describeSweptWorkspaces } from "./machine-activity";
import { describeForecastDays, measureDisk } from "./machine";

/** How many workspaces "Largest idle workspaces" lists. */
const LARGEST_IDLE_COUNT = 5;

const MS_PER_MINUTE = 60_000;

const OTHER_TOOLTIP =
  "Everything else on the disk: your own files, and package stores such as pnpm's, which workspaces link to.";

/** The name of a part of the bar. */
export type StoragePartKey =
  | "inUse"
  | "idle"
  | "repositoryCaches"
  | "sessionData"
  | "other"
  | "free";

/** One part of the bar, which is also one entry of the legend under it. */
export interface StoragePart {
  readonly key: StoragePartKey;
  /** Such as "Workspaces in use", "Idle workspaces" or "Session data". */
  readonly label: string;
  readonly bytes: number;
  /** Such as "128 GB". */
  readonly sizeText: string;
  /**
   * The part's share of the bar, from 0 to 1, or `null` while the runner has
   * not reported its disk's total size. The shares add up to at most 1.
   */
  readonly share: number | null;
  /** Explains the part on hover; only Other has one. */
  readonly tooltip: string | null;
}

/** The info popover of the automatic cleanup line. */
export interface AutomaticCleanupRules {
  readonly intro: string;
  readonly items: readonly string[];
  readonly closing: string;
}

/** The line on automatic cleanup. */
export interface AutomaticCleanup {
  /** "Hercule cleans up by itself." */
  readonly text: string;
  /** The newest removal the sweep made, in the faint ink: "Last: removed 2 workspaces of finished runs, yesterday.". `null` when the activity holds none. */
  readonly last: string | null;
  readonly rules: AutomaticCleanupRules;
}

/** Everything the Storage section draws. */
export interface MachineStorage {
  readonly head: {
    /** Such as "412 GB free of 1,000 GB", or "412 GB free" while the disk's total size is unknown. */
    readonly freeText: string;
    /** Such as "limit in about 12 days", drawn after a dot in the `you` ink. `null` when there is no forecast. */
    readonly forecastText: string | null;
  };
  /** Empty before the runner has reported its disk. Just Free for a runner that does not measure storage. */
  readonly parts: readonly StoragePart[];
  /**
   * Where the disk limit mark sits: the limit's share of the disk, counted
   * from the right edge of the bar (the free end). `null` when the disk's
   * total size is unknown.
   */
  readonly limitShare: number | null;
  /**
   * The line shown in place of everything under the bar when the runner is too
   * old to measure its storage, else `null`.
   */
  readonly tooOld: string | null;
  /** Absent when `tooOld` is set. */
  readonly automaticCleanup: AutomaticCleanup | null;
  /** The five largest idle workspaces a Thread used, largest first. Empty when `tooOld` is set. */
  readonly largestIdle: readonly IdleWorkspaceRow[];
  readonly cleanUp: {
    /** Why Clean up… is disabled, or `null` when the machine is online and it is enabled. */
    readonly disabledHint: string | null;
  };
}

/** The sum of `pick` over `items`. */
const sum = <Item>(items: readonly Item[], pick: (item: Item) => number): number =>
  items.reduce((total, item) => total + pick(item), 0);

/**
 * Describes the newest removal the sweep made out of the machine's `events`
 * (its audit log entries, newest first), or returns `null` when none is among
 * them. Only the sweep records a reason on `workspace.deleted`, so an entry
 * with one is the sweep's. Entries with the same reason in the same minute as
 * the newest one are counted together, as the activity list folds them.
 * `now` and `timezone` word the day.
 */
const describeLastSweep = (
  events: readonly Pick<Event, "kind" | "payload" | "receivedAt">[],
  timezone: string,
  now: Date,
): string | null => {
  const reasonOf = (event: Pick<Event, "kind" | "payload">): string | undefined => {
    const reason = event.kind === "workspace.deleted" ? event.payload["reason"] : undefined;
    return typeof reason === "string" ? reason : undefined;
  };
  const newest = events.find((event) => reasonOf(event) !== undefined);
  if (newest === undefined) return null;
  const reason = reasonOf(newest)!;
  const minute = Math.floor(Date.parse(newest.receivedAt) / MS_PER_MINUTE);
  const count = events.filter(
    (event) =>
      reasonOf(event) === reason &&
      Math.floor(Date.parse(event.receivedAt) / MS_PER_MINUTE) === minute,
  ).length;
  const day = formatDayStamp(new Date(newest.receivedAt), timezone, now);
  if (day === undefined) return null;
  const when = day === "Today" ? "today" : day === "Yesterday" ? "yesterday" : `on ${day}`;
  return `Last: removed ${describeSweptWorkspaces(reason, count)}, ${when}.`;
};

const AUTOMATIC_CLEANUP_RULES: AutomaticCleanupRules = {
  intro: "When Hercule removes a workspace by itself, with everything in it:",
  items: [
    "a workflow run's workspace, as soon as the run finishes, or 14 days after it failed;",
    "a thread's workspace, once every thread in it is archived and nobody has used it for 7 days.",
  ],
  closing: "Everything else stays until you clean it up.",
};

/**
 * Builds the bar's parts from the machine's measured workspaces and its
 * runner totals.
 *
 * - Workspace parts add up `freesBytes`, never `sizeBytes`, so no byte is
 *   counted twice. A workspace that is removed or lost, or was never measured,
 *   adds nothing. A workspace is idle when `isIdleWorkspace` says so, else in
 *   use.
 * - Other is the disk's total, less the free space and every other part. A
 *   measurement older than the free-space reading can make that negative, so
 *   it is floored at 0.
 * - Shares are counted against the larger of the disk's total and the parts'
 *   sum, so the bar never overflows when measurements and the free-space
 *   reading disagree.
 */
const buildStorageParts = (
  runner: Runner,
  workspaces: readonly Workspace[],
  freeBytes: number,
  totalBytes: number | null,
  now: Date,
): readonly StoragePart[] => {
  const measured = workspaces.filter(
    (workspace) =>
      workspace.runnerId === runner.id &&
      workspace.diskUsage !== null &&
      workspace.status !== "deleted" &&
      workspace.status !== "lost",
  );
  const freesOf = (workspace: Workspace): number => workspace.diskUsage?.freesBytes ?? 0;
  const idleBytes = sum(
    measured.filter((workspace) => isIdleWorkspace(workspace, now)),
    freesOf,
  );
  const inUseBytes = sum(
    measured.filter((workspace) => !isIdleWorkspace(workspace, now)),
    freesOf,
  );
  const repositoryCacheBytes = runner.diskUsage?.repositoryCacheBytes ?? 0;
  const sessionDataBytes = runner.diskUsage?.harnessHomeBytes ?? 0;
  const counted = inUseBytes + idleBytes + repositoryCacheBytes + sessionDataBytes;
  const otherBytes = totalBytes === null ? 0 : Math.max(0, totalBytes - freeBytes - counted);
  const shareBase =
    totalBytes === null ? null : Math.max(totalBytes, counted + otherBytes + freeBytes);

  const part = (
    key: StoragePartKey,
    label: string,
    bytes: number,
    tooltip: string | null = null,
  ): StoragePart => ({
    key,
    label,
    bytes,
    sizeText: formatDiskSize(bytes),
    share: shareBase === null ? null : bytes / shareBase,
    tooltip,
  });
  return [
    part("inUse", "Workspaces in use", inUseBytes),
    part("idle", "Idle workspaces", idleBytes),
    part("repositoryCaches", "Repository caches", repositoryCacheBytes),
    part("sessionData", "Session data", sessionDataBytes),
    part("other", "Other", otherBytes, OTHER_TOOLTIP),
    part("free", "Free", freeBytes),
  ];
};

/** What `describeMachineStorage` reads. */
export interface MachineStorageSources {
  readonly runner: Runner;
  /**
   * The capabilities the runner negotiated with the controller
   * (`RunnerDetail.negotiatedCapabilities`, from `runner.read`), or `null`
   * while they are not known. A machine is too old to measure only when they
   * are known and lack the disk usage capability.
   */
  readonly negotiatedCapabilities: readonly string[] | null;
  /** Every workspace the shell holds, of any machine. The machine's own are picked out here. */
  readonly workspaces: readonly Workspace[];
  /** The Threads `readCleanupThreads` read for the machine's cleanup candidates. `[]` before they are read. */
  readonly threads: readonly Session[];
  /** The hour points of this machine alone, oldest first, for the forecast. */
  readonly hourPoints: readonly RunnerMetricsPoint[];
  /** The machine's recent audit log entries, newest first, as the activity list reads them. */
  readonly events: readonly Pick<Event, "kind" | "payload" | "receivedAt">[];
  readonly timezone: string;
  readonly now: Date;
}

/**
 * Describes the Storage section of a machine's page.
 *
 * - The head has the free space and, when `forecastDiskLimit` finds one, the
 *   forecast. A runner that reported no disk yet has "Disk not reported yet".
 * - A runner known to lack the disk usage capability shows only Free and the
 *   line that says it is too old. The workspaces, the activity and the
 *   Threads are not read for it.
 * - "Largest idle workspaces" are the machine's cleanup candidates that a
 *   Thread used, the five with the biggest `sizeBytes` first. A workspace
 *   never measured goes last.
 * - Clean up… is disabled while the machine is not online.
 */
export const describeMachineStorage = ({
  runner,
  negotiatedCapabilities,
  workspaces,
  threads,
  hourPoints,
  events,
  timezone,
  now,
}: MachineStorageSources): MachineStorage => {
  const disk = measureDisk(runner);
  const totalBytes = disk?.use?.totalBytes ?? null;
  const tooOld =
    negotiatedCapabilities !== null && !negotiatedCapabilities.includes(DISK_USAGE_CAPABILITY);
  const forecast = forecastDiskLimit(hourPoints, runner, now.getTime());
  const cleanUp = {
    disabledHint:
      runner.connectivity === "online"
        ? null
        : `${runner.name} is offline. Cleaning up needs it online.`,
  };
  const head = {
    freeText:
      disk === null
        ? "Disk not reported yet"
        : totalBytes === null
          ? `${formatDiskSize(disk.freeBytes)} free`
          : `${formatDiskSize(disk.freeBytes)} free of ${formatDiskSize(totalBytes)}`,
    forecastText: forecast === null ? null : `limit in about ${describeForecastDays(forecast)}`,
  };
  const limitShare =
    totalBytes === null ? null : Math.min(1, runner.diskWatermarkBytes / totalBytes);
  if (disk === null) {
    return {
      head,
      parts: [],
      limitShare,
      tooOld: null,
      automaticCleanup: null,
      largestIdle: [],
      cleanUp,
    };
  }
  if (tooOld) {
    const parts = buildStorageParts(runner, [], disk.freeBytes, totalBytes, now).filter(
      (part) => part.key === "free",
    );
    return {
      head,
      parts,
      limitShare,
      tooOld:
        "This machine's runner is too old to measure its storage. Update it to see what fills the disk.",
      automaticCleanup: null,
      largestIdle: [],
      cleanUp,
    };
  }
  const largestIdle = buildIdleWorkspaceRows(
    listCleanupCandidates(workspaces, runner.id, now),
    threads,
    now,
  )
    .toSorted((a, b) => (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1))
    .slice(0, LARGEST_IDLE_COUNT);
  return {
    head,
    parts: buildStorageParts(runner, workspaces, disk.freeBytes, totalBytes, now),
    limitShare,
    tooOld: null,
    automaticCleanup: {
      text: "Hercule cleans up by itself.",
      last: describeLastSweep(events, timezone, now),
      rules: AUTOMATIC_CLEANUP_RULES,
    },
    largestIdle,
    cleanUp,
  };
};
