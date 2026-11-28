/**
 * Keeps the disk usage of this runner's managed workspaces, repository caches
 * and Harness Homes, and reports it to the controller (spec 03 section 6.9).
 *
 * One idea drives it: something is changing the workspace's files. A session
 * running in it changes them, and so does its removal. Each of those calls
 * `beginChange` before it can write or delete, and `endChange` when it is done
 * (a removal that succeeds calls `forget` instead, because the workspace is
 * gone). The rule that decides what to measure is a per-workspace counter:
 *
 * - `generation` goes up, and is saved, at every `beginChange` and every
 *   `endChange`. The begin is saved before the change can touch a file.
 * - `measuredGeneration` is the generation the last walk began at, whether it
 *   succeeded or failed.
 * - A workspace is dirty when `generation > measuredGeneration`. It is measured
 *   when it is dirty and no change is in progress in it.
 * - A walk saves its result only if the generation is still the one it began
 *   at. Otherwise something changed the files while it walked, so the result
 *   may describe files that no longer exist: it is dropped, the earlier
 *   numbers stay, and the workspace stays dirty.
 *
 * So a workspace nobody changed since its last walk is never walked again, a
 * failed walk does not retry in a loop, a change that starts or ends during a
 * walk leaves the workspace dirty, and a runner that crashed in the middle of a
 * change measures that workspace once at boot.
 *
 * The counters and the last results are saved in `disk-usage.json` in the
 * storage directory, so a restart keeps them and the first report after a
 * restart carries real numbers. The file is only a cache of measurements: a
 * missing or invalid file makes every workspace dirty.
 *
 * Two kinds of change are saved differently, because the file holds every
 * workspace and rewriting it is costly:
 *
 * - A counter change (a change begins or ends, a workspace appears or is
 *   forgotten) is saved at once, before the change can write or delete. The write is atomic but not synced to the disk, so
 *   the save survives a crash of this process, not a power loss. A lost save
 *   only means one more walk.
 * - A measurement result is saved at most once every `REPORT_INTERVAL`, and
 *   once more when the daemon's scope closes at a clean stop. A crash can lose
 *   a result that was not saved yet. That costs one more walk of the
 *   workspace after the restart and nothing else, so it is safe.
 */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join as joinPath } from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import {
  DiskUsageError,
  MAX_DISK_USAGE_ERROR_LENGTH,
  MAX_MEASURED_WORKSPACES,
  RunnerDiskUsage,
  StorageId,
  WorkspaceDiskUsage,
  type DiskUsageReport,
  type RunnerDiskUsageReport,
} from "@hercule/protocol";
import type { Registry, RegisteredWorkspace } from "../workspaces/registry";
import type { MeasureFolder } from "./folder-measurer";

/** The repository caches and Harness Homes are measured at most this often. */
export const SHARED_MEASUREMENT_INTERVAL: Duration.Duration = Duration.minutes(10);

/** A report goes out at most this often. */
export const REPORT_INTERVAL: Duration.Duration = Duration.seconds(10);

/**
 * Characters `DiskUsageError` refuses: control characters (C0, DEL and C1),
 * bidirectional controls, and lone surrogates. With the `u` flag, `\p{Surrogate}`
 * matches only a surrogate that is not half of a pair.
 */
const REFUSED_ERROR_CHARACTERS = /[\p{Cc}\u202a-\u202e\u2066-\u2069\p{Surrogate}]/gu;

/**
 * Returns an error text the protocol accepts in a workspace's entry: each
 * refused character, such as the newline of a child's stderr, becomes a space,
 * and the text is cut to `MAX_DISK_USAGE_ERROR_LENGTH` UTF-16 units. The cut
 * is made between characters, so it never splits a surrogate pair.
 */
const shortenError = (message: string): string => {
  let kept = "";
  for (const character of message.replace(REFUSED_ERROR_CHARACTERS, " ")) {
    if (kept.length + character.length > MAX_DISK_USAGE_ERROR_LENGTH) break;
    kept += character;
  }
  return kept;
};

const StoredWorkspace = Schema.Struct({
  generation: Schema.Int,
  measuredGeneration: Schema.Int,
  /** Epoch milliseconds of the newest session start or exit seen here, or of the first sighting. */
  lastUsedAt: Schema.Number,
  diskUsage: Schema.NullOr(WorkspaceDiskUsage),
  error: Schema.NullOr(DiskUsageError),
});

type StoredWorkspace = Schema.Schema.Type<typeof StoredWorkspace>;

const StoredState = Schema.Struct({
  version: Schema.Literal(1),
  workspaces: Schema.Record(StorageId, StoredWorkspace),
  runner: Schema.NullOr(RunnerDiskUsage),
});

const decodeState = Schema.decodeUnknownResult(StoredState);

export type SavedState = Schema.Schema.Type<typeof StoredState>;

/** A workspace's mutable record while the daemon runs. */
type WorkspaceRecord = { -readonly [K in keyof StoredWorkspace]: StoredWorkspace[K] };

/** What the code that changes a workspace's files tells this module. */
export interface WorkspaceChangeObserver {
  /**
   * Records that something is about to change the workspace's files, and
   * saves it. The workspace is not measured until the matching `endChange`.
   * Call it before the first write or delete. Never fails.
   */
  readonly beginChange: (workspaceId: string) => Effect.Effect<void>;
  /**
   * Records that the change is over, whether it worked or not, and saves it.
   * The workspace is measured once no other change is in progress in it.
   * Never fails.
   */
  readonly endChange: (workspaceId: string) => Effect.Effect<void>;
}

/** What the workspaces tell this module about their own lifecycle. */
export interface WorkspaceLifecycleObserver extends WorkspaceChangeObserver {
  /**
   * Records that the workspace is ready, so it is measured. This is not a
   * change: the registry does not know the workspace while it is prepared, so
   * no record can hold it until now. Never fails.
   */
  readonly workspaceReady: (workspaceId: string) => Effect.Effect<void>;
  /**
   * Forgets the workspace, because its removal succeeded. A walk that is
   * still running cannot save its numbers afterwards. Never fails.
   */
  readonly forget: (workspaceId: string) => Effect.Effect<void>;
}

export interface DiskMeasurements extends WorkspaceLifecycleObserver {
  /**
   * The changes of sessions. Like the methods above, and each one also
   * records the workspace as used now. A removal is a change but not a use,
   * and the report keeps the most recently used workspaces when it must cut.
   */
  readonly sessionChanges: WorkspaceChangeObserver;
  /** Builds the report from what is known now. */
  readonly buildReport: Effect.Effect<RunnerDiskUsageReport>;
  /**
   * Sends a report at once, and again after each measurement, at most one
   * every `REPORT_INTERVAL`: a measurement that ends inside the interval is
   * sent when it passes. Runs until interrupted, and fails when `send` fails.
   */
  readonly reportTo: <E>(
    send: (frame: DiskUsageReport) => Effect.Effect<void, E>,
  ) => Effect.Effect<never, E>;
}

export interface DiskMeasurementsOptions {
  readonly storageDir: string;
  /**
   * The registry of this runner's workspaces. Only read: it says which
   * workspaces exist, which are managed, and which are ready.
   */
  readonly registry: Pick<Registry, "all" | "held">;
  readonly measureFolder: MeasureFolder;
  /**
   * Writes the saved state. Defaults to an atomic write of `disk-usage.json`
   * in the storage directory; tests pass one that fails.
   */
  readonly writeState?: (storageDir: string, state: SavedState) => void;
}

const buildStatePath = (storageDir: string): string => joinPath(storageDir, "disk-usage.json");

/** Returns true for a workspace the runner owns and measures: not an adopted main workspace. */
const isManaged = (entry: RegisteredWorkspace): boolean => entry.ownership !== "adopted";

/** Returns true for a managed workspace whose files are all there: prepared, or older than preparation records. */
const isMeasurable = (entry: RegisteredWorkspace): boolean =>
  isManaged(entry) &&
  (entry.preparation === undefined ||
    (entry.preparation.phase === "terminal" && entry.preparation.report.status === "ready"));

/**
 * Returns a time to start a workspace's `lastUsedAt` from: when its folder
 * last changed, or now when the folder cannot be read. Only used for a
 * workspace the runner meets for the first time.
 */
const guessLastUsedAt = (root: string): number => {
  try {
    return Math.floor(statSync(root).mtimeMs);
  } catch {
    return Date.now();
  }
};

const buildStartingRecord = (root: string): WorkspaceRecord => ({
  generation: 1,
  measuredGeneration: 0,
  lastUsedAt: guessLastUsedAt(root),
  diskUsage: null,
  error: null,
});

/**
 * Reads the saved state. A missing file is an empty state. An unreadable or
 * invalid file is logged and also gives an empty state, because the file only
 * caches what a new walk finds again.
 */
const readSavedState = (storageDir: string): Effect.Effect<SavedState | undefined> =>
  Effect.suspend(() => {
    let content: string;
    try {
      content = readFileSync(buildStatePath(storageDir), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return Effect.succeed(undefined);
      return Effect.as(
        Effect.logWarning(
          "The runner could not read its saved disk usage, so it measures again",
          error,
        ),
        undefined,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = undefined;
    }
    const decoded = decodeState(parsed);
    if (Result.isSuccess(decoded)) return Effect.succeed(decoded.success);
    return Effect.as(
      Effect.logWarning("The runner's saved disk usage is invalid, so it measures again"),
      undefined,
    );
  });

/** Writes the state to a temporary file and renames it over the saved one, so a crash never leaves half a file. */
const writeSavedState = (storageDir: string, state: SavedState): void => {
  const path = buildStatePath(storageDir);
  mkdirSync(storageDir, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
};

/**
 * Creates the disk measurements of this runner and starts their worker, which
 * lives as long as `Scope`. The worker measures every dirty workspace once the
 * registry has been read, then waits until a change ends or a workspace becomes
 * ready. A removal that succeeds does not wake it: that workspace is gone. It
 * runs one walk at a time.
 */
export const makeDiskMeasurements = (
  options: DiskMeasurementsOptions,
): Effect.Effect<DiskMeasurements, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { storageDir, registry, measureFolder, writeState = writeSavedState } = options;
    const scope = yield* Effect.scope;
    const saved = yield* readSavedState(storageDir);
    const records = new Map<string, WorkspaceRecord>(
      Object.entries(saved?.workspaces ?? {}).map(([id, record]) => [id, { ...record }]),
    );
    let runner = saved?.runner ?? null;
    // Changes in progress in each workspace now. A crash loses it on purpose:
    // no change survives the process.
    const holders = new Map<string, number>();
    const wake = yield* Queue.sliding<void>(1);
    // Where a report change is signalled, while a connection is reporting.
    let reportChanged: Queue.Queue<void> | undefined;
    // Set once the repository caches and Harness Homes have been measured in this process.
    let sharedMeasuredAt: number | undefined;

    // Whether a measurement result is in memory but not in the file yet.
    let resultsUnsaved = false;
    // Whether a fiber is waiting to save those results.
    let saveScheduled = false;

    /**
     * Writes the whole state to the file, results included.
     *
     * When the write fails, the older file on disk may hold a generation that
     * is now behind the workspaces, and a restart after a crash would trust
     * it. So the file is deleted, which works even on a full disk, and the
     * next start measures every workspace. The state in memory stays marked as
     * unsaved, and the next write tries again.
     */
    const persist: Effect.Effect<void> = Effect.suspend(() => {
      resultsUnsaved = false;
      try {
        writeState(storageDir, {
          version: 1,
          workspaces: Object.fromEntries(records),
          runner,
        });
        return Effect.void;
      } catch (error) {
        resultsUnsaved = true;
        try {
          rmSync(buildStatePath(storageDir), { force: true });
        } catch (removal) {
          return Effect.logWarning(
            "The runner could not save its disk usage, and could not delete the older saved file either. " +
              "If the runner stops without a clean exit, it may trust numbers that are out of date.",
            { writeError: error, deleteError: removal },
          );
        }
        return Effect.logWarning(
          "The runner could not save its disk usage. It deleted the older saved file, so the next start measures every workspace again.",
          error,
        );
      }
    });

    /** Saves the measurement results once `REPORT_INTERVAL` has passed, unless a counter change saved them sooner. */
    const saveResultsSoon: Effect.Effect<void> = Effect.suspend(() => {
      resultsUnsaved = true;
      if (saveScheduled) return Effect.void;
      saveScheduled = true;
      return Effect.forkIn(
        Effect.andThen(
          Effect.sleep(REPORT_INTERVAL),
          Effect.suspend(() => {
            saveScheduled = false;
            return resultsUnsaved ? persist : Effect.void;
          }),
        ),
        scope,
      ).pipe(Effect.asVoid);
    });

    yield* Effect.addFinalizer(() => (resultsUnsaved ? persist : Effect.void));

    const readRegistered = (workspaceId: string): Effect.Effect<RegisteredWorkspace | undefined> =>
      registry.held(workspaceId).pipe(Effect.catch(() => Effect.succeed(undefined)));

    /** Returns the workspace's record, creating it when the workspace is managed here. Undefined for any other workspace. */
    const ensureRecord = (workspaceId: string): Effect.Effect<WorkspaceRecord | undefined> =>
      Effect.gen(function* () {
        const known = records.get(workspaceId);
        if (known !== undefined) return known;
        const entry = yield* readRegistered(workspaceId);
        if (entry === undefined || !isManaged(entry)) return undefined;
        // Another fiber may have created it while the registry was read.
        const created = records.get(workspaceId) ?? buildStartingRecord(entry.root);
        records.set(workspaceId, created);
        return created;
      });

    const beginChange = (workspaceId: string, isUse: boolean): Effect.Effect<void> =>
      Effect.gen(function* () {
        const record = yield* ensureRecord(workspaceId);
        if (record === undefined) return;
        record.generation += 1;
        if (isUse) record.lastUsedAt = Date.now();
        holders.set(workspaceId, (holders.get(workspaceId) ?? 0) + 1);
        yield* persist;
      });

    const endChange = (workspaceId: string, isUse: boolean): Effect.Effect<void> =>
      Effect.gen(function* () {
        const record = yield* ensureRecord(workspaceId);
        if (record === undefined) return;
        record.generation += 1;
        if (isUse) record.lastUsedAt = Date.now();
        const remaining = (holders.get(workspaceId) ?? 0) - 1;
        if (remaining > 0) holders.set(workspaceId, remaining);
        else holders.delete(workspaceId);
        yield* persist;
        Queue.offerUnsafe(wake, undefined);
      });

    /**
     * Brings the records in line with the registry and returns the workspaces
     * that can be measured, with their folders: drops the records of
     * workspaces that are gone or adopted, and creates the records of managed
     * workspaces that have none (those from before this feature).
     */
    const syncWithRegistry = Effect.gen(function* () {
      const listed = yield* registry.all();
      const managed = new Map(listed.filter(isManaged).map((entry) => [entry.workspaceId, entry]));
      let changed = false;
      for (const id of [...records.keys()]) {
        if (managed.has(id)) continue;
        records.delete(id);
        holders.delete(id);
        changed = true;
      }
      for (const [id, entry] of managed) {
        if (records.has(id) || !isMeasurable(entry)) continue;
        records.set(id, buildStartingRecord(entry.root));
        changed = true;
      }
      if (changed) yield* persist;
      return listed.filter(isMeasurable);
    });

    const signalReportChanged = Effect.sync(() => {
      if (reportChanged !== undefined) Queue.offerUnsafe(reportChanged, undefined);
    });

    /** Walks one workspace and saves the outcome, unless a change touched the workspace during the walk. */
    const measureWorkspace = (entry: RegisteredWorkspace): Effect.Effect<void> =>
      Effect.gen(function* () {
        const walkedGeneration = records.get(entry.workspaceId)?.generation;
        if (walkedGeneration === undefined) return;
        const outcome = yield* Effect.result(measureFolder(entry.root));
        const measuredAt = new Date().toISOString();
        // A forgotten workspace has no record. Any change that began, or began
        // and ended, during the walk moved the generation: the walk may have
        // seen files that are gone or half written, so its outcome is dropped
        // and the workspace stays dirty.
        const record = records.get(entry.workspaceId);
        if (record === undefined || record.generation !== walkedGeneration) return;
        record.measuredGeneration = walkedGeneration;
        if (Result.isSuccess(outcome)) {
          record.diskUsage = { ...outcome.success, measuredAt };
          record.error = null;
        } else {
          record.error = shortenError(outcome.failure.message);
        }
        yield* saveResultsSoon;
        yield* signalReportChanged;
      });

    /** Measures the repository caches and every Harness Home, together, and saves them. A failure keeps the earlier numbers. */
    const measureShared: Effect.Effect<void> = Effect.gen(function* () {
      sharedMeasuredAt = Date.now();
      // A folder that does not exist yet holds nothing.
      const measureFreesBytes = (folder: string) =>
        existsSync(folder)
          ? Effect.map(measureFolder(folder), (usage) => usage.freesBytes)
          : Effect.succeed(0);
      const outcome = yield* Effect.result(
        Effect.all([
          measureFreesBytes(joinPath(storageDir, "cache")),
          measureFreesBytes(joinPath(storageDir, "providers")),
        ]),
      );
      if (Result.isFailure(outcome)) {
        yield* Effect.logWarning(
          `The runner could not measure its repository caches and Harness Homes: ${outcome.failure.message}`,
        );
        return;
      }
      runner = {
        repositoryCacheBytes: outcome.success[0],
        harnessHomeBytes: outcome.success[1],
        measuredAt: new Date().toISOString(),
      };
      yield* saveResultsSoon;
      yield* signalReportChanged;
    });

    /**
     * Measures every workspace that is dirty and has no change in progress in
     * it, newest use first, one at a time. Then measures the repository
     * caches and Harness Homes when this call measured a workspace or it is
     * the first call, and the last time was at least
     * `SHARED_MEASUREMENT_INTERVAL` ago.
     *
     * The registry is read once, up front: reading it again for each walk
     * would parse the whole file thousands of times at boot. A workspace that
     * becomes dirty meanwhile is picked up by the next call, which every
     * change that ends and ready workspace schedules.
     */
    const measureDirtyWorkspaces: Effect.Effect<void> = Effect.gen(function* () {
      const measurable = [...(yield* syncWithRegistry)].sort(
        (a, b) => records.get(b.workspaceId)!.lastUsedAt - records.get(a.workspaceId)!.lastUsedAt,
      );
      let measuredAny = false;
      for (const entry of measurable) {
        const record = records.get(entry.workspaceId);
        if (
          record === undefined ||
          holders.has(entry.workspaceId) ||
          record.generation <= record.measuredGeneration
        )
          continue;
        yield* measureWorkspace(entry);
        measuredAny = true;
      }
      const due =
        sharedMeasuredAt === undefined ||
        (measuredAny &&
          Date.now() - sharedMeasuredAt >= Duration.toMillis(SHARED_MEASUREMENT_INTERVAL));
      if (due) yield* measureShared;
    }).pipe(
      Effect.catch((error: Error) =>
        Effect.logWarning(`The runner could not measure disk usage: ${error.message}`),
      ),
    );

    Queue.offerUnsafe(wake, undefined);
    yield* Effect.forkScoped(
      Effect.forever(Effect.andThen(Queue.take(wake), measureDirtyWorkspaces)),
    );

    const buildReport: Effect.Effect<RunnerDiskUsageReport> = Effect.sync(() => {
      const newestFirst = [...records].sort(([, a], [, b]) => b.lastUsedAt - a.lastUsedAt);
      return {
        workspaces: newestFirst.slice(0, MAX_MEASURED_WORKSPACES).map(([workspaceId, record]) => ({
          workspaceId,
          diskUsage: record.diskUsage,
          error: record.error,
        })),
        truncated: newestFirst.length > MAX_MEASURED_WORKSPACES,
        runner,
      };
    });

    return {
      beginChange: (workspaceId) => beginChange(workspaceId, false),
      endChange: (workspaceId) => endChange(workspaceId, false),
      sessionChanges: {
        beginChange: (workspaceId) => beginChange(workspaceId, true),
        endChange: (workspaceId) => endChange(workspaceId, true),
      },
      workspaceReady: (workspaceId) =>
        Effect.gen(function* () {
          yield* ensureRecord(workspaceId);
          Queue.offerUnsafe(wake, undefined);
        }),
      forget: (workspaceId) =>
        Effect.gen(function* () {
          holders.delete(workspaceId);
          if (records.delete(workspaceId)) yield* persist;
        }),
      buildReport,
      reportTo: (send) =>
        Effect.gen(function* () {
          const changed = yield* Queue.sliding<void>(1);
          reportChanged = changed;
          // The first signal sends the report straight after hello.
          Queue.offerUnsafe(changed, undefined);
          return yield* Effect.forever(
            Effect.gen(function* () {
              yield* Queue.take(changed);
              yield* Effect.flatMap(buildReport, (diskUsage) =>
                send({ _tag: "diskUsageReport", diskUsage }),
              );
              yield* Effect.sleep(REPORT_INTERVAL);
            }),
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                // A newer connection may have replaced the slot already.
                if (reportChanged === changed) reportChanged = undefined;
              }),
            ),
          );
        }),
    };
  });
