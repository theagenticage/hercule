/**
 * The pure logic of the Storage section on a machine's page of the desktop
 * Fleet screen (spec 17 §A machine's page point 5): the head with the free
 * space and the forecast, the disk as one bar in parts, the line on automatic
 * cleanup, and the largest idle workspaces. No function here reads a clock
 * or a store.
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
  isIdleWorkspace,
  listCleanupCandidates,
  type IdleWorkspaceRow,
} from "./cleanup";
import { forecastDiskLimit } from "./disk-forecast";
import {
  describeMachineActivity,
  describeSweptWorkspaces,
  readSweepReason,
} from "./machine-activity";
import { describeForecastDays, formatDiskSize, measureDisk } from "./machine";

/** How many workspaces "Largest idle workspaces" lists. */
const LARGEST_IDLE_COUNT = 5;

const OTHER_TOOLTIP =
  "Everything else on the disk: your own files, and package stores such as pnpm's, which workspaces link to.";

/** The name of a part of the bar. */
export type StoragePartKey = "inUse" | "idle" | "repositoryCaches" | "sessionData" | "other";

/**
 * One part of the bar, which is also one entry of the legend under it. Free
 * space is not a part: it is the bar's own background, and the head says how
 * much there is.
 */
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

/** The disk as one bar, the free space being the bar's background. */
export interface StorageBar {
  /** Left to right. Empty for a runner that is too old to measure storage. */
  readonly parts: readonly StoragePart[];
  /**
   * Where the disk limit mark sits: the limit's share of the disk, counted
   * from the right edge of the bar (the free end). `null` when the disk's
   * total size is unknown.
   */
  readonly limitShare: number | null;
}

/** Everything the Storage section draws. */
export interface MachineStorage {
  readonly head: {
    /** Such as "412 GB free of 1,000 GB", or "412 GB free" while the disk's total size is unknown. */
    readonly freeText: string;
    /** Such as "limit in about 12 days", drawn after a dot in the `you` ink. `null` when there is no forecast. */
    readonly forecastText: string | null;
  };
  /** The disk as one bar. `null` before the runner has reported its disk. */
  readonly bar: StorageBar | null;
  /**
   * The line shown in place of everything under the bar when the runner is too
   * old to measure its storage, else `null`.
   */
  readonly tooOld: string | null;
  /** Absent when `tooOld` is set. */
  readonly automaticCleanup: AutomaticCleanup | null;
  /** The five largest idle workspaces a Thread used, largest first. Empty when `tooOld` is set. */
  readonly largestIdle: readonly IdleWorkspaceRow[];
}

/**
 * Checks whether the runner with these `negotiatedCapabilities`
 * (`RunnerDetail.negotiatedCapabilities`, from `runner.read`) can measure the
 * disk usage of its workspaces. Capabilities that are not known yet (`null`)
 * count as yes: the section then draws what it has, and a runner that turns
 * out to be too old shows its line once they arrive.
 */
export const canMeasureStorage = (negotiatedCapabilities: readonly string[] | null): boolean =>
  negotiatedCapabilities === null || negotiatedCapabilities.includes(DISK_USAGE_CAPABILITY);

/** The sum of `pick` over `items`. */
const sum = <Item>(items: readonly Item[], pick: (item: Item) => number): number =>
  items.reduce((total, item) => total + pick(item), 0);

/**
 * Describes the newest removal the sweep made out of the machine's `events`
 * (its audit log entries, newest first), or returns `null` when none is among
 * them. `readSweepReason` tells which entries are the sweep's. The count is the
 * activity list's own fold of the newest entry, so the page and the list never
 * disagree. `now` and `timezone` word the day.
 */
const describeLastSweep = (
  events: readonly Pick<Event, "id" | "kind" | "payload" | "actor" | "receivedAt">[],
  timezone: string,
  now: Date,
): string | null => {
  const sweeps = events.filter((event) => readSweepReason(event) !== undefined);
  const newest = sweeps[0];
  if (newest === undefined) return null;
  const folded = describeMachineActivity(sweeps, {
    filter: "all",
    timezone,
    today: now,
    accounts: [],
  })[0]?.entries[0];
  const day = formatDayStamp(new Date(newest.receivedAt), timezone, now);
  if (folded === undefined || day === undefined) return null;
  const when = day === "Today" ? "today" : day === "Yesterday" ? "yesterday" : `on ${day}`;
  return `Last: removed ${describeSweptWorkspaces(readSweepReason(newest)!, folded.count)}, ${when}.`;
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
 * - Every share is a part's drawn bytes over the disk's real total, the same
 *   total the disk limit mark (`limitShare`) uses, so the free space left
 *   over and the mark line up.
 * - Stale measurements can make the counted parts bigger than the disk's
 *   used space. The bar then draws the workspace parts smaller, in the same
 *   proportion, until the parts fit; their texts keep the measured sizes. If
 *   the repository caches and the session data alone do not fit, they are
 *   drawn smaller in the same proportion too, and the workspace parts are not
 *   drawn.
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
  const readFreesBytes = (workspace: Workspace): number => workspace.diskUsage?.freesBytes ?? 0;
  const idleBytes = sum(
    measured.filter((workspace) => isIdleWorkspace(workspace, now)),
    readFreesBytes,
  );
  const inUseBytes = sum(
    measured.filter((workspace) => !isIdleWorkspace(workspace, now)),
    readFreesBytes,
  );
  const repositoryCacheBytes = runner.diskUsage?.repositoryCacheBytes ?? 0;
  const sessionDataBytes = runner.diskUsage?.harnessHomeBytes ?? 0;
  const counted = inUseBytes + idleBytes + repositoryCacheBytes + sessionDataBytes;
  const otherBytes = totalBytes === null ? 0 : Math.max(0, totalBytes - freeBytes - counted);

  // How much of each part the bar draws: all of it unless the parts overflow the used space.
  const usedBytes = totalBytes === null ? 0 : Math.max(0, totalBytes - freeBytes);
  const fixedBytes = repositoryCacheBytes + sessionDataBytes;
  const workspaceBytes = inUseBytes + idleBytes;
  const workspaceDrawn =
    workspaceBytes === 0 ? 1 : Math.min(1, Math.max(0, usedBytes - fixedBytes) / workspaceBytes);
  const fixedDrawn = fixedBytes === 0 ? 1 : Math.min(1, usedBytes / fixedBytes);
  const drawnFraction: Readonly<Record<StoragePartKey, number>> = {
    inUse: workspaceDrawn * fixedDrawn,
    idle: workspaceDrawn * fixedDrawn,
    repositoryCaches: fixedDrawn,
    sessionData: fixedDrawn,
    other: 1,
  };

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
    share: totalBytes === null ? null : (bytes * drawnFraction[key]) / totalBytes,
    tooltip,
  });
  return [
    part("inUse", "Workspaces in use", inUseBytes),
    part("idle", "Idle workspaces", idleBytes),
    part("repositoryCaches", "Repository caches", repositoryCacheBytes),
    part("sessionData", "Session data", sessionDataBytes),
    part("other", "Other", otherBytes, OTHER_TOOLTIP),
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
  readonly events: readonly Pick<Event, "id" | "kind" | "payload" | "actor" | "receivedAt">[];
  readonly timezone: string;
  readonly now: Date;
}

/**
 * Describes the Storage section of a machine's page.
 *
 * - The head has the free space and, when `forecastDiskLimit` finds one, the
 *   forecast. A runner that reported no disk yet has "Disk not reported yet".
 * - A runner known to lack the disk usage capability (`canMeasureStorage`)
 *   shows its bar empty, all free, and the line that says it is too old, with
 *   no automatic cleanup line and no largest idle workspaces.
 * - The bar shows what fills the disk, so its "Idle workspaces" part counts
 *   every idle workspace (`isIdleWorkspace`) of the machine, main and run
 *   workspaces included. Clean up… offers fewer: only the ephemeral ones a
 *   Thread used (`listCleanupCandidates`).
 * - "Largest idle workspaces" are those cleanup candidates, the five that
 *   removing would give back the most space (`freesBytes`), largest first.
 *   A workspace never measured goes last.
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
  const tooOld = !canMeasureStorage(negotiatedCapabilities);
  const forecast = forecastDiskLimit(hourPoints, runner, now.getTime());
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
      bar: null,
      tooOld: null,
      automaticCleanup: null,
      largestIdle: [],
    };
  }
  if (tooOld) {
    return {
      head,
      bar: { parts: [], limitShare },
      tooOld:
        "This machine's runner is too old to measure its storage. Update it to see what fills the disk.",
      automaticCleanup: null,
      largestIdle: [],
    };
  }
  const largestIdle = buildIdleWorkspaceRows(
    listCleanupCandidates(workspaces, runner.id, now),
    threads,
    now,
  )
    .toSorted((a, b) => (b.freesBytes ?? -1) - (a.freesBytes ?? -1))
    .slice(0, LARGEST_IDLE_COUNT);
  return {
    head,
    bar: {
      parts: buildStorageParts(runner, workspaces, disk.freeBytes, totalBytes, now),
      limitShare,
    },
    tooOld: null,
    automaticCleanup: {
      text: "Hercule cleans up by itself.",
      last: describeLastSweep(events, timezone, now),
      rules: AUTOMATIC_CLEANUP_RULES,
    },
    largestIdle,
  };
};
