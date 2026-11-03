/**
 * Tests the disk measurements through their interface, on real directories and
 * the registry file the daemon reads. The folder walk is the real walker run
 * in this process, wrapped to count and to hold walks back; the one test about
 * a deadline runs a real child process.
 */
import { mkdirSync, mkdtempSync, linkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Duration, Effect, Exit, Scope } from "effect";
import type { DiskUsageReport, RunnerDiskUsageReport } from "@hercule/protocol";
import { makeRegistry, type RegisteredWorkspace } from "../workspaces/registry";
import { makeFolderMeasurer, MeasuringFailed, type MeasureFolder } from "./folder-measurer";
import { makeDiskMeasurements, type DiskMeasurements } from "./measurements";
import { walkFolder } from "./walker";

const folders: string[] = [];
const scopes: Scope.Closeable[] = [];

afterEach(async () => {
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void));
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A storage directory with a registry, and a walker that counts the folders it walks. */
const makeRunner = () => {
  const storageDir = mkdtempSync(join(tmpdir(), "hercule-measurements-"));
  folders.push(storageDir);
  const registry = makeRegistry(storageDir);
  const walked: string[] = [];
  const walkLatches = new Map<string, { gate: Promise<void>; started: () => void }>();
  let failWith: string | undefined;

  const measureFolder: MeasureFolder = (folder) =>
    Effect.tryPromise({
      try: async () => {
        walked.push(folder);
        const latch = walkLatches.get(folder);
        if (latch !== undefined) {
          latch.started();
          await latch.gate;
        }
        if (failWith !== undefined) throw new Error(failWith);
        return walkFolder(folder);
      },
      catch: (error) =>
        new MeasuringFailed({ message: error instanceof Error ? error.message : String(error) }),
    });

  const start = async (measure: MeasureFolder = measureFolder): Promise<DiskMeasurements> => {
    const scope = Scope.makeUnsafe();
    scopes.push(scope);
    return Effect.runPromise(
      makeDiskMeasurements({ storageDir, registry, measureFolder: measure }).pipe(
        Scope.provide(scope),
      ),
    );
  };

  /** Registers a ready workspace with a few files, and returns its folder. */
  const addWorkspace = async (
    workspaceId: string,
    ownership: "managed" | "adopted" = "managed",
  ): Promise<string> => {
    const root = join(storageDir, "workspaces", workspaceId);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "file.txt"), Buffer.alloc(40_000, 1));
    const entry: RegisteredWorkspace = {
      workspaceId,
      kind: "ephemeral",
      root,
      checkouts: [],
      ownership,
    };
    await Effect.runPromise(registry.update((entries) => [...entries, entry]));
    return root;
  };

  /** Creates the repository cache folder, whose walk ends every daemon's first pass. */
  const addRepositoryCache = (): string => {
    const cache = join(storageDir, "cache");
    mkdirSync(cache, { recursive: true });
    return cache;
  };

  const countWalks = (folder: string): number => walked.filter((one) => one === folder).length;

  const waitForWalks = async (folder: string, count: number): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (countWalks(folder) < count && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(countWalks(folder)).toBeGreaterThanOrEqual(count);
  };

  const removeFromRegistry = (workspaceId: string) =>
    Effect.runPromise(
      registry.update((entries) => entries.filter((entry) => entry.workspaceId !== workspaceId)),
    );

  /** Makes walks of `folder` wait until the returned function is called. */
  const holdWalks = (folder: string) => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const beganWalking = new Promise<void>((resolve) => (started = resolve));
    walkLatches.set(folder, { gate, started });
    return { release, beganWalking };
  };

  return {
    storageDir,
    walked,
    start,
    addWorkspace,
    addRepositoryCache,
    countWalks,
    waitForWalks,
    removeFromRegistry,
    holdWalks,
    failWalks: (message: string | undefined) => {
      failWith = message;
    },
  };
};

const report = (measurements: DiskMeasurements): Promise<RunnerDiskUsageReport> =>
  Effect.runPromise(measurements.buildReport);

/** Polls until the report satisfies `ready`, and returns it. */
const waitForReport = async (
  measurements: DiskMeasurements,
  ready: (report: RunnerDiskUsageReport) => boolean,
): Promise<RunnerDiskUsageReport> => {
  const deadline = Date.now() + 10_000;
  let latest = await report(measurements);
  while (!ready(latest) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    latest = await report(measurements);
  }
  expect(ready(latest), `the report never became ready: ${JSON.stringify(latest)}`).toBe(true);
  return latest;
};

const entryOf = (found: RunnerDiskUsageReport, workspaceId: string) =>
  found.workspaces.find((entry) => entry.workspaceId === workspaceId);

const isMeasured = (workspaceId: string) => (found: RunnerDiskUsageReport) =>
  entryOf(found, workspaceId)?.diskUsage != null || entryOf(found, workspaceId)?.error != null;

describe("disk measurements", () => {
  it("measures a ready workspace at start and counts hard-linked files in its size but not in what removing it frees", async () => {
    const runner = makeRunner();
    const root = await runner.addWorkspace("ws-pnpm");
    const store = join(runner.storageDir, "pnpm-store");
    mkdirSync(store);
    writeFileSync(join(store, "dep.js"), Buffer.alloc(200_000, 2));
    mkdirSync(join(root, "node_modules"));
    linkSync(join(store, "dep.js"), join(root, "node_modules", "dep.js"));
    mkdirSync(join(runner.storageDir, "cache", "repo.git"), { recursive: true });
    writeFileSync(join(runner.storageDir, "cache", "repo.git", "pack"), Buffer.alloc(60_000, 3));

    const measurements = await runner.start();
    const found = await waitForReport(
      measurements,
      (r) => isMeasured("ws-pnpm")(r) && r.runner !== null,
    );

    const usage = entryOf(found, "ws-pnpm")!.diskUsage!;
    expect(usage.sizeBytes - usage.freesBytes).toBeGreaterThanOrEqual(200_000);
    expect(usage.freesBytes).toBeGreaterThanOrEqual(40_000);
    expect(entryOf(found, "ws-pnpm")!.error).toBeNull();
    // The cache holds one 60 KB file; there is no Harness Home yet.
    expect(found.runner!.repositoryCacheBytes).toBeGreaterThanOrEqual(60_000);
    expect(found.runner!.harnessHomeBytes).toBe(0);
    expect(found.truncated).toBe(false);
  });

  it("does not walk a workspace again when no session started or exited in it", async () => {
    const runner = makeRunner();
    const unused = await runner.addWorkspace("ws-unused");
    await runner.addWorkspace("ws-busy");
    const measurements = await runner.start();
    await waitForReport(
      measurements,
      (r) => isMeasured("ws-unused")(r) && isMeasured("ws-busy")(r),
    );

    await Effect.runPromise(measurements.sessionStarted("ws-busy"));
    await Effect.runPromise(measurements.sessionEnded("ws-busy"));
    // The pass the exit scheduled walks ws-busy again; it ends before the
    // report shows a second measurement time for it.
    const busyWalks = () => runner.walked.filter((folder) => folder.endsWith("ws-busy")).length;
    const deadline = Date.now() + 10_000;
    while (busyWalks() < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));

    expect(busyWalks()).toBe(2);
    expect(runner.walked.filter((folder) => folder === unused)).toHaveLength(1);
  });

  it("keeps its numbers across a restart, and measures nothing it measured before", async () => {
    const runner = makeRunner();
    const root = await runner.addWorkspace("ws-a");
    const cache = runner.addRepositoryCache();
    const first = await runner.start();
    const before = await waitForReport(first, isMeasured("ws-a"));
    await runner.waitForWalks(cache, 1);

    // A second daemon over the same storage, as after a restart. Its first
    // pass ends with the walk of the repository cache.
    const second = await runner.start();
    await runner.waitForWalks(cache, 2);

    expect(entryOf(await report(second), "ws-a")).toEqual(entryOf(before, "ws-a"));
    expect(runner.countWalks(root)).toBe(1);
  });

  it("measures after a restart a workspace a session started in and never left, such as after a crash", async () => {
    const runner = makeRunner();
    const root = await runner.addWorkspace("ws-crashed");
    const first = await runner.start();
    await waitForReport(first, isMeasured("ws-crashed"));
    await Effect.runPromise(first.sessionStarted("ws-crashed"));
    writeFileSync(join(root, "written-by-the-session.bin"), Buffer.alloc(300_000, 4));

    const second = await runner.start();
    const found = await waitForReport(
      second,
      (r) => (entryOf(r, "ws-crashed")?.diskUsage?.sizeBytes ?? 0) >= 300_000,
    );

    expect(entryOf(found, "ws-crashed")!.diskUsage!.sizeBytes).toBeGreaterThanOrEqual(340_000);
  });

  it("waits to measure a workspace while a session works in it", async () => {
    const runner = makeRunner();
    const measurements = await runner.start();
    await runner.addWorkspace("ws-working");
    await runner.addWorkspace("ws-other");
    await Effect.runPromise(measurements.sessionStarted("ws-working"));
    await Effect.runPromise(measurements.workspaceReady("ws-working"));
    await Effect.runPromise(measurements.workspaceReady("ws-other"));
    // Passes run one after another, so once ws-other is measured the pass
    // that saw ws-working has decided.
    await waitForReport(measurements, isMeasured("ws-other"));

    expect(runner.walked.some((folder) => folder.endsWith("ws-working"))).toBe(false);

    await Effect.runPromise(measurements.sessionEnded("ws-working"));
    await waitForReport(measurements, isMeasured("ws-working"));
  });

  it("leaves a workspace dirty when a session starts during its walk", async () => {
    const runner = makeRunner();
    const root = await runner.addWorkspace("ws-raced");
    const cache = runner.addRepositoryCache();
    const walk = runner.holdWalks(root);
    const first = await runner.start();
    await walk.beganWalking;

    await Effect.runPromise(first.sessionStarted("ws-raced"));
    walk.release();
    // The numbers of the walk are kept, but the workspace is still dirty:
    // a daemon that starts over the same storage, as after a crash with the
    // session still working, measures it again.
    await waitForReport(first, isMeasured("ws-raced"));
    await runner.waitForWalks(cache, 1);
    expect(runner.countWalks(root)).toBe(1);
    await runner.start();

    await runner.waitForWalks(root, 2);
  });

  it("does not bring back a workspace removed during its walk", async () => {
    const runner = makeRunner();
    const root = await runner.addWorkspace("ws-removed");
    const walk = runner.holdWalks(root);
    const measurements = await runner.start();
    await walk.beganWalking;

    await runner.removeFromRegistry("ws-removed");
    await Effect.runPromise(measurements.workspaceRemoved("ws-removed"));
    walk.release();
    await runner.addWorkspace("ws-after");
    await Effect.runPromise(measurements.workspaceReady("ws-after"));
    await waitForReport(measurements, isMeasured("ws-after"));

    expect(entryOf(await report(measurements), "ws-removed")).toBeUndefined();
    const restarted = await runner.start();
    expect(entryOf(await report(restarted), "ws-removed")).toBeUndefined();
  });

  it("does not save the numbers of a workspace whose removal began during its walk", async () => {
    const runner = makeRunner();
    const root = await runner.addWorkspace("ws-leaving");
    const walk = runner.holdWalks(root);
    const measurements = await runner.start();
    await walk.beganWalking;

    // The registry no longer holds the workspace, but the removal is not complete yet.
    await runner.removeFromRegistry("ws-leaving");
    walk.release();
    await runner.addWorkspace("ws-after");
    await Effect.runPromise(measurements.workspaceReady("ws-after"));
    await waitForReport(measurements, isMeasured("ws-after"));

    expect(entryOf(await report(measurements), "ws-leaving")).toBeUndefined();
  });

  it("never measures an adopted main workspace", async () => {
    const runner = makeRunner();
    await runner.addWorkspace("ws-adopted", "adopted");
    await runner.addWorkspace("ws-managed");
    const measurements = await runner.start();
    await waitForReport(measurements, isMeasured("ws-managed"));

    expect(entryOf(await report(measurements), "ws-adopted")).toBeUndefined();
    expect(runner.walked.some((folder) => folder.endsWith("ws-adopted"))).toBe(false);
  });

  it("keeps the earlier numbers when a walk fails, and clears the error when a walk succeeds", async () => {
    const runner = makeRunner();
    await runner.addWorkspace("ws-flaky");
    const measurements = await runner.start();
    const good = entryOf(await waitForReport(measurements, isMeasured("ws-flaky")), "ws-flaky")!;

    runner.failWalks("Cannot read /x\nbecause it is broken");
    await Effect.runPromise(measurements.sessionStarted("ws-flaky"));
    await Effect.runPromise(measurements.sessionEnded("ws-flaky"));
    const failed = entryOf(
      await waitForReport(measurements, (r) => entryOf(r, "ws-flaky")?.error != null),
      "ws-flaky",
    )!;

    expect(failed.diskUsage).toEqual(good.diskUsage);
    // A newline would be refused by the protocol.
    expect(failed.error).toBe("Cannot read /x because it is broken");

    runner.failWalks(undefined);
    await Effect.runPromise(measurements.sessionStarted("ws-flaky"));
    await Effect.runPromise(measurements.sessionEnded("ws-flaky"));
    await waitForReport(measurements, (r) => entryOf(r, "ws-flaky")?.error === null);
  });

  it("reports an error and no numbers when the first walk passes its deadline", async () => {
    const runner = makeRunner();
    await runner.addWorkspace("ws-slow");
    const measurements = await runner.start(
      makeFolderMeasurer({
        deadline: Duration.millis(200),
        buildCommand: () => ["sleep", "30"],
      }),
    );

    const found = await waitForReport(measurements, isMeasured("ws-slow"));

    expect(entryOf(found, "ws-slow")).toEqual({
      workspaceId: "ws-slow",
      diskUsage: null,
      error: "Measuring took longer than 10 minutes",
    });
  });

  it("sends a report as soon as it is asked to report, then stays quiet until something is measured", async () => {
    const runner = makeRunner();
    await runner.addWorkspace("ws-reported");
    const measurements = await runner.start();
    await waitForReport(measurements, (r) => isMeasured("ws-reported")(r) && r.runner !== null);

    const sent: DiskUsageReport[] = [];
    const scope = Scope.makeUnsafe();
    scopes.push(scope);
    Effect.runFork(
      measurements
        .reportTo((frame) => Effect.sync(() => void sent.push(frame)))
        .pipe(Scope.provide(scope)),
    );
    const deadline = Date.now() + 5000;
    while (sent.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));

    expect(sent).toHaveLength(1);
    expect(sent[0]!._tag).toBe("diskUsageReport");
    expect(entryOf(sent[0]!.diskUsage, "ws-reported")?.diskUsage).not.toBeNull();
  });
});
