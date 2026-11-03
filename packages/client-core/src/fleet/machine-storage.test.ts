/**
 * Tests the Storage section of a machine's page through `describeMachineStorage`:
 * the head, the bar's parts and how they are counted, the largest idle
 * workspaces and their measuring notes, the automatic cleanup line, the
 * state of a runner too old to measure, and the Clean up… button.
 */
import type { Event, Runner, RunnerFacts, RunnerMetricsPoint, Workspace } from "@hercule/contract";
import { describe, expect, it } from "vitest";
import { buildSession, buildWorkspace } from "../threads/workspaces.testing";
import { canMeasureStorage, describeMachineStorage, type MachineStorage } from "./machine-storage";

const GB = 1e9;
const HOUR_MS = 3_600_000;
const NOW = new Date("2026-11-03T12:00:00.000Z");
const RUNNER_ID = "01a06d02-beff-7037-9f5b-042822015952";

const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

/** The facts of a runner whose disk is `diskTotalBytes` big, or of unknown size. */
const buildFacts = (diskTotalBytes?: number): RunnerFacts => ({
  os: "linux",
  arch: "x64",
  totalMemoryBytes: 16 * 1024 ** 3,
  docker: false,
  toolchains: [],
  harnesses: [],
  adapters: [],
  identityPort: 7000,
  ...(diskTotalBytes === undefined ? {} : { diskTotalBytes }),
});

/** A runner with a 1,000 GB disk of which 412 GB are free, and a disk limit of 100 GB. */
const buildRunner = (over: Partial<Runner> = {}): Runner => ({
  id: RUNNER_ID,
  name: "atlas",
  connectivity: "online",
  lifecycle: "active",
  reserved: false,
  version: "0.9.3",
  labels: [],
  facts: buildFacts(1000 * GB),
  metrics: { diskFreeBytes: 412 * GB, availableMemoryBytes: 8 * 1024 ** 3 },
  diskUsage: {
    repositoryCacheBytes: 20 * GB,
    harnessHomeBytes: 5 * GB,
    measuredAt: daysAgo(0),
  },
  maxConcurrentSessions: 16,
  diskWatermarkBytes: 100 * GB,
  lastSeenAt: daysAgo(0),
  ...over,
});

/** Returns a workspace of the machine that was last used `usedDaysAgo` days ago and frees `freesGb` GB. */
const buildMeasured = (
  id: string,
  freesGb: number,
  usedDaysAgo: number,
  over: Partial<Workspace> = {},
): Workspace =>
  buildWorkspace({
    id,
    runnerId: RUNNER_ID,
    kind: "ephemeral",
    lastUsedAt: daysAgo(usedDaysAgo),
    diskUsage: { sizeBytes: freesGb * 2 * GB, freesBytes: freesGb * GB, measuredAt: daysAgo(1) },
    ...over,
  });

const NO_SOURCES = {
  negotiatedCapabilities: ["diskUsage"],
  workspaces: [],
  threads: [],
  hourPoints: [],
  events: [],
  timezone: "UTC",
  now: NOW,
};

/** Describes the storage of `runner` from `NO_SOURCES` and `over`. */
const describeStorage = (
  runner: Runner,
  over: Partial<Parameters<typeof describeMachineStorage>[0]> = {},
): MachineStorage => describeMachineStorage({ ...NO_SOURCES, runner, ...over });

/** Returns the bytes of each part by key. */
const bytesByKey = (storage: MachineStorage): Record<string, number> =>
  Object.fromEntries(storage.bar!.parts.map((part) => [part.key, part.bytes / GB]));

/** Returns hour points over 3 days whose free space falls 1.5 GB an hour, from 500 GB to 392 GB. */
const fallingPoints = (): RunnerMetricsPoint[] =>
  Array.from({ length: 73 }, (_, index) => ({
    runnerId: RUNNER_ID,
    at: new Date(NOW.getTime() - (72 - index) * HOUR_MS).toISOString(),
    minutes: 60,
    diskFreeBytes: (500 - index * 1.5) * GB,
    availableMemoryBytes: 8 * 1024 ** 3,
    availableMemoryLowestBytes: 6 * 1024 ** 3,
    cpuAveragePercent: null,
    cpuPeakPercent: null,
    sessionsRunning: 0,
    sessionsQueued: 0,
  }));

describe("describeMachineStorage head", () => {
  it("shows the free space of the disk without a forecast", () => {
    expect(describeStorage(buildRunner()).head).toEqual({
      freeText: "412 GB free of 1,000 GB",
      forecastText: null,
    });
  });

  it("adds the forecast when the free space falls toward the limit", () => {
    // The free space falls 1.5 GB an hour over 3 days, so the 100 GB limit is some days away.
    const runner = buildRunner({ metrics: { diskFreeBytes: 392 * GB, availableMemoryBytes: 1 } });

    const { head } = describeStorage(runner, { hourPoints: fallingPoints() });

    expect(head.freeText).toBe("392 GB free of 1,000 GB");
    expect(head.forecastText).toMatch(/^limit in about \d+ days?$/);
  });

  it("shows the free space alone when the runner does not report its disk's total size", () => {
    const storage = describeStorage(buildRunner({ facts: buildFacts() }));

    expect(storage.head.freeText).toBe("412 GB free");
    expect(storage.bar!.limitShare).toBeNull();
    expect(storage.bar!.parts.every((part) => part.share === null)).toBe(true);
  });

  it("says the disk is not reported before the runner has reported it", () => {
    const storage = describeStorage(buildRunner({ metrics: null }));

    expect(storage.head.freeText).toBe("Disk not reported yet");
    expect(storage.bar).toBeNull();
  });

  it("places the disk limit mark at its share of the disk", () => {
    expect(describeStorage(buildRunner()).bar!.limitShare).toBe(0.1);
  });
});

describe("describeMachineStorage parts", () => {
  it("counts workspaces by what removing them frees, idle apart from in use, and sums the rest as Other", () => {
    const workspaces = [
      buildMeasured("w-use", 10, 1),
      buildMeasured("w-held", 20, 30, { sessionIds: ["s-1"] }),
      buildMeasured("w-idle", 30, 8),
      buildMeasured("w-gone", 99, 30, { status: "deleted" }),
      buildMeasured("w-lost", 99, 30, { status: "lost" }),
      buildMeasured("w-elsewhere", 99, 30, { runnerId: "other" }),
      buildWorkspace({ id: "w-new", runnerId: RUNNER_ID, diskUsage: null }),
    ];

    const storage = describeStorage(buildRunner(), { workspaces });

    // Free is the bar's background, not a part.
    expect(storage.bar!.parts.map((part) => part.label)).toEqual([
      "Workspaces in use",
      "Idle workspaces",
      "Repository caches",
      "Session data",
      "Other",
    ]);
    // 1000 total - 412 free - (30 in use + 30 idle + 20 caches + 5 session data) = 503 other.
    expect(bytesByKey(storage)).toEqual({
      inUse: 30,
      idle: 30,
      repositoryCaches: 20,
      sessionData: 5,
      other: 503,
    });
    expect(storage.bar!.parts.map((part) => part.sizeText)).toEqual([
      "30 GB",
      "30 GB",
      "20 GB",
      "5 GB",
      "503 GB",
    ]);
    expect(storage.bar!.parts.find((part) => part.key === "other")!.tooltip).toBe(
      "Everything else on the disk: your own files, and package stores such as pnpm's, which workspaces link to.",
    );
    // The parts fill the used space, and the free space is what is left of the bar.
    expect(storage.bar!.parts.reduce((sum, part) => sum + (part.share ?? 0), 0)).toBeCloseTo(
      1 - 0.412,
    );
  });

  it("floors Other at zero and shrinks the workspace parts when stale measurements add up to too much", () => {
    const workspaces = [buildMeasured("w-big", 700, 1)];

    const storage = describeStorage(buildRunner(), { workspaces });

    const share = (key: string): number | null =>
      storage.bar!.parts.find((part) => part.key === key)!.share;
    expect(bytesByKey(storage)["other"]).toBe(0);
    // The texts keep the measured sizes.
    expect(bytesByKey(storage)["inUse"]).toBe(700);
    expect(share("repositoryCaches")).toBe(0.02);
    expect(share("sessionData")).toBe(0.005);
    // 1000 - 412 free - 25 for caches and session data leaves 563 for the workspace.
    expect(share("inUse")).toBeCloseTo(0.563);
    // The parts still leave the free space free, so it lines up with the disk limit mark.
    expect(storage.bar!.parts.reduce((sum, part) => sum + (part.share ?? 0), 0)).toBeCloseTo(
      1 - 0.412,
    );
    expect(storage.bar!.limitShare).toBe(0.1);
  });

  it("counts a runner that has not yet measured its caches as holding none", () => {
    const storage = describeStorage(buildRunner({ diskUsage: null }));

    expect(bytesByKey(storage)).toMatchObject({ repositoryCaches: 0, sessionData: 0 });
  });
});

describe("describeMachineStorage largest idle workspaces", () => {
  const idle = (id: string, freesGb: number, over: Partial<Workspace> = {}) =>
    buildMeasured(id, freesGb, 12, over);
  const threadIn = (workspace: Workspace, title: string) =>
    buildSession({ id: `t-${workspace.id}`, workspaceId: workspace.id, title });

  it("lists the five largest idle workspaces a Thread used, by size, with their names", () => {
    const workspaces = Array.from({ length: 7 }, (_, index) =>
      idle(`w-${String(index)}`, index + 1),
    );
    const unused = idle("w-unused", 99);
    const threads = workspaces.map((workspace) => threadIn(workspace, `Work ${workspace.id}`));

    const { largestIdle } = describeStorage(buildRunner(), {
      workspaces: [...workspaces, unused],
      threads,
    });

    expect(largestIdle.map((row) => row.name)).toEqual([
      "Work w-6",
      "Work w-5",
      "Work w-4",
      "Work w-3",
      "Work w-2",
    ]);
    expect(largestIdle[0]).toMatchObject({
      sizeText: "14 GB",
      freesText: "7 GB",
      lastUsedText: "1 week ago",
      measuringNote: null,
    });
  });

  it("leaves out workspaces used in the last 7 days and main workspaces", () => {
    const recent = buildMeasured("w-recent", 5, 6);
    const main = idle("w-main", 5, { kind: "primary" });

    const { largestIdle } = describeStorage(buildRunner(), {
      workspaces: [recent, main],
      threads: [threadIn(recent, "Recent"), threadIn(main, "Main")],
    });

    expect(largestIdle).toEqual([]);
  });

  it("says how old the sizes are and why measuring failed", () => {
    const failed = idle("w-failed", 5, {
      diskUsage: { sizeBytes: 10 * GB, freesBytes: 5 * GB, measuredAt: daysAgo(3) },
      diskUsageError: "Measuring took longer than 10 minutes",
    });

    const { largestIdle } = describeStorage(buildRunner(), {
      workspaces: [failed],
      threads: [threadIn(failed, "Failing")],
    });

    expect(largestIdle[0]!.measuringNote).toBe(
      "Sizes from 3 days ago: measuring took longer than 10 minutes.",
    );
  });

  it("says a workspace was not measured yet, with its reason when there is one, and lists it last", () => {
    const never = idle("w-never", 0, {
      diskUsage: null,
      diskUsageError: "Measuring took longer than 10 minutes.",
    });
    const unknown = idle("w-unknown", 0, { diskUsage: null });
    const measured = idle("w-measured", 1);

    const { largestIdle } = describeStorage(buildRunner(), {
      workspaces: [never, unknown, measured],
      threads: [
        threadIn(never, "Never"),
        threadIn(unknown, "Unknown"),
        threadIn(measured, "Measured"),
      ],
    });

    expect(largestIdle.map((row) => [row.name, row.sizeText, row.measuringNote])).toEqual([
      ["Measured", "2 GB", null],
      ["Never", null, "Not measured yet: measuring took longer than 10 minutes."],
      ["Unknown", null, "Not measured yet."],
    ]);
  });
});

describe("describeMachineStorage automatic cleanup", () => {
  const swept = (
    id: number,
    reason: string,
    at: string,
  ): Pick<Event, "kind" | "payload" | "receivedAt"> => ({
    kind: "workspace.deleted",
    payload: { workspaceId: `w-${String(id)}`, reason },
    receivedAt: at,
  });

  it("names the newest removal the sweep made, folding those of the same minute", () => {
    // Newest first, as the activity list reads them.
    const events = [
      swept(3, "idle", "2026-11-02T08:30:50.000Z"),
      swept(2, "none", "2026-11-02T08:30:40.000Z"),
      swept(1, "none", "2026-11-02T08:30:10.000Z"),
      swept(4, "none", "2026-10-01T08:30:10.000Z"),
    ];

    const { automaticCleanup } = describeStorage(buildRunner(), { events });

    expect(automaticCleanup?.text).toBe("Hercule cleans up by itself.");
    // The newest entry is the "idle" one; the "none" ones are another reason.
    expect(automaticCleanup?.last).toBe("Last: removed an idle workspace, yesterday.");
    const onlyNone = describeStorage(buildRunner(), { events: events.slice(1) });
    expect(onlyNone.automaticCleanup?.last).toBe(
      "Last: removed 2 workspaces of finished runs, yesterday.",
    );
  });

  it("words today and an older day", () => {
    const today = describeStorage(buildRunner(), {
      events: [swept(1, "orphan", "2026-11-03T09:00:00.000Z")],
    });
    const older = describeStorage(buildRunner(), {
      events: [swept(1, "archived", "2026-10-20T09:00:00.000Z")],
    });

    expect(today.automaticCleanup?.last).toBe(
      "Last: removed a workspace no thread can resume, today.",
    );
    expect(older.automaticCleanup?.last).toBe(
      "Last: removed an archived thread's workspace, on 20 Oct.",
    );
  });

  it("has no last removal when the removals in the activity are not the sweep's", () => {
    const byUser = {
      kind: "workspace.deleted",
      payload: { workspaceId: "w-1" },
      receivedAt: "2026-11-02T08:30:10.000Z",
    } as const;

    expect(describeStorage(buildRunner(), { events: [byUser] }).automaticCleanup?.last).toBeNull();
    expect(describeStorage(buildRunner()).automaticCleanup?.last).toBeNull();
  });
});

describe("describeMachineStorage on a runner too old to measure", () => {
  it("shows an empty bar and the line that says to update", () => {
    const storage = describeStorage(buildRunner({ diskUsage: null }), {
      negotiatedCapabilities: ["somethingElse"],
      workspaces: [buildMeasured("w-1", 10, 20)],
    });

    expect(storage.bar).toEqual({ parts: [], limitShare: 0.1 });
    expect(storage.tooOld).toBe(
      "This machine's runner is too old to measure its storage. Update it to see what fills the disk.",
    );
    expect(storage.automaticCleanup).toBeNull();
    expect(storage.largestIdle).toEqual([]);
  });

  it("does not call a runner old while its capabilities are not known", () => {
    const storage = describeStorage(buildRunner(), { negotiatedCapabilities: null });

    expect(storage.tooOld).toBeNull();
    expect(storage.bar!.parts).toHaveLength(5);
  });
});

describe("canMeasureStorage", () => {
  it("says yes while the capabilities are not known, and when they list disk usage", () => {
    expect(canMeasureStorage(null)).toBe(true);
    expect(canMeasureStorage(["diskUsage"])).toBe(true);
  });

  it("says no for a runner whose capabilities lack disk usage", () => {
    expect(canMeasureStorage([])).toBe(false);
    expect(canMeasureStorage(["somethingElse"])).toBe(false);
  });
});

describe("describeMachineStorage Clean up…", () => {
  it("is enabled while the machine is online", () => {
    expect(describeStorage(buildRunner()).cleanUp.disabledHint).toBeNull();
  });

  it.each(["offline", "unreachable"] as const)(
    "is disabled while the machine is %s",
    (connectivity) => {
      expect(describeStorage(buildRunner({ connectivity })).cleanUp.disabledHint).toBe(
        "atlas is offline. Cleaning up needs it online.",
      );
    },
  );
});
