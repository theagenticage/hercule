/**
 * Times what the controller does with a runner's `DiskUsageReport` of
 * `MAX_MEASURED_WORKSPACES` (2,000) entries, and prints the medians and the
 * slowest runs. Run it with `pnpm test:speed`.
 *
 * It is opt-in, and not part of `pnpm test` or CI, because time depends on the
 * machine. The database is the test database every controller test uses: a
 * file in a temporary folder, in WAL mode, with a writer and a read-only
 * reader (ADR 0004, amendment of 2026-10-18), not SQLite's in-memory mode. It
 * is seeded with a migrated schema and no statistics, as a controller starts.
 *
 * The database holds one runner with 2,000 ready workspaces, each with a
 * stored measurement. It times:
 *
 * - reading the frame as the runner socket reads every frame: `JSON.parse`,
 *   the check of the protocol version, and the decode of `RunnerToController`;
 * - the transaction the inbound handler runs for the report, with the
 *   workspaces' entries and the runner's own totals, when 50 entries changed
 *   and the other 1,950 are as stored;
 * - the same transaction when all 2,000 entries changed.
 *
 * The transaction calls the two repositories' `recordDiskUsage` inside
 * `withTransaction`, as `WorkspaceService.recordDiskUsage` and
 * `RunnerService.recordDiskUsage` do inside the handler's transaction; the two
 * services add nothing to it but joining that transaction.
 *
 * What it guards is an order of magnitude: the write reads the stored values
 * in one statement and writes only the entries that changed, so its time
 * follows the changed entries more than the size of the report. Each ceiling
 * is about ten times what its step takes on a developer's Mac, so it catches a
 * step that grows tenfold, not a small slowdown.
 */
import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import {
  MAX_MEASURED_WORKSPACES,
  PeerVersion,
  RunnerToController,
  type DiskUsageReport,
  type WorkspaceDiskUsageEntry,
} from "@hercule/protocol";
import { withTransaction } from "../db";
import { buildAnnouncementRecorder, inTransaction, TestDatabase } from "../db/testing";
import { uuidFromString } from "../db/id";
import { runnerRepository } from "../runners";
import { workspaceRepository } from "./repository";

/** Set to "1" by `pnpm test:speed`. */
const SPEED_TESTS_ENABLED = process.env["RUN_SPEED_TESTS"] === "1";

/** The most time reading one frame of 2,000 entries may take, in milliseconds. */
const DECODE_CEILING_MS = 10;

/** The most time the transaction may take when 50 entries changed, in milliseconds. */
const WRITE_CEILING_MS = 30;

/** How often each step is timed after it has warmed up. */
const RUNS = 25;
const WARM_UP_RUNS = 5;

/** The entries of a report that changed since the one before, in the first write case. */
const CHANGED_ENTRIES = 50;

const RUNNER = "0199e0e7-0000-7000-8000-0000000000a1";
const MEASURED_AT_MS = Date.parse("2026-11-03T10:00:00.000Z");
const MEASURED_AT = new Date(MEASURED_AT_MS).toISOString();

/** SQL for the id of workspace `i` as 32 hex digits: a version 7 UUID that holds `i`. */
const WORKSPACE_ID = "printf('%08x000070008003%012x', i, 0)";

/** Returns the canonical id of workspace `i`, the id `WORKSPACE_ID` writes. */
const buildWorkspaceId = (i: number): string =>
  `${i.toString(16).padStart(8, "0")}-0000-7000-8003-000000000000`;

/** The size the seed stores for workspace `i`, which the entries of the reports start from. */
const buildSizeBytes = (i: number): number => 1_000_000_000 + i * 1_000_003;

/**
 * Writes the runner and its `MAX_MEASURED_WORKSPACES` ready workspaces, each
 * measured at `MEASURED_AT` with a size of `buildSizeBytes(i)` of which half is
 * freed by removing it, in one transaction.
 */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels, credential_hash,
                         created_at, updated_at)
    VALUES (${uuidFromString(RUNNER)}, 'laptop', 'online', 'active', 0, '[]', 'laptop',
            '2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.000Z')`;
  yield* sql`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n
                            WHERE i < ${MAX_MEASURED_WORKSPACES})
    INSERT INTO workspaces (id, runner_id, kind, status, created_at, last_used_at, size_bytes,
                            frees_bytes, disk_usage_measured_at)
    SELECT ${sql.literal(`unhex(${WORKSPACE_ID})`)}, ${uuidFromString(RUNNER)}, 'ephemeral',
           'ready', '2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.000Z',
           1000000000 + i * 1000003, (1000000000 + i * 1000003) / 2, ${MEASURED_AT}
    FROM n`;
}).pipe(inTransaction);

/**
 * Builds the report of run `run`, in which the first `changed` entries hold a
 * newer measurement than the run before, and the rest are as the seed stored
 * them. The runner's own totals are measured anew in every run.
 */
const buildReport = (run: number, changed: number): DiskUsageReport => {
  const measuredAt = new Date(MEASURED_AT_MS + (run + 1) * 10_000).toISOString();
  const workspaces: Array<WorkspaceDiskUsageEntry> = [];
  for (let i = 1; i <= MAX_MEASURED_WORKSPACES; i++) {
    const sizeBytes = buildSizeBytes(i) + (i <= changed ? (run + 1) * 4096 : 0);
    workspaces.push({
      workspaceId: buildWorkspaceId(i),
      diskUsage: {
        sizeBytes,
        freesBytes: Math.floor(sizeBytes / 2),
        measuredAt: i <= changed ? measuredAt : MEASURED_AT,
      },
      error: null,
    });
  }
  return {
    _tag: "diskUsageReport",
    diskUsage: {
      workspaces,
      truncated: false,
      runner: { repositoryCacheBytes: 4_000_000_000, harnessHomeBytes: 900_000_000, measuredAt },
    },
  };
};

/** The median and the slowest of the timed runs of a step, in milliseconds. */
interface Timing {
  readonly medianMs: number;
  readonly maxMs: number;
}

/**
 * Times `measured` and returns the median and the slowest of the runs after
 * the warm-up. `run` is the number of the run, from 0, for a step that needs
 * new input each time.
 */
const measure = <E, R>(measured: (run: number) => Effect.Effect<unknown, E, R>) =>
  Effect.gen(function* () {
    const times: Array<number> = [];
    for (let run = 0; run < WARM_UP_RUNS + RUNS; run++) {
      const started = performance.now();
      yield* measured(run);
      if (run >= WARM_UP_RUNS) times.push(performance.now() - started);
    }
    const sorted = times.toSorted((a, b) => a - b);
    const timing: Timing = {
      medianMs: sorted[Math.floor(sorted.length / 2)]!,
      maxMs: sorted.at(-1)!,
    };
    return timing;
  });

const decodePeerVersion = Schema.decodeUnknownEffect(PeerVersion);
const decodeFrame = Schema.decodeUnknownEffect(RunnerToController);

/**
 * Reads a frame's text as the runner socket does: parses the JSON, checks for
 * a protocol version (which a report does not carry), and decodes the frame.
 * Fails when the frame does not decode.
 */
const readFrame = (raw: string) =>
  Effect.gen(function* () {
    const parsed: unknown = JSON.parse(raw);
    yield* Effect.option(decodePeerVersion(parsed));
    return yield* decodeFrame(parsed);
  });

/**
 * Times the handler's transaction for the reports in which `changed` entries
 * changed, and returns the timing and how many `workspace` changes were
 * announced in each run. The reports are built before the timing starts.
 */
const measureWrite = (changed: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const workspaces = yield* workspaceRepository;
    const runners = yield* runnerRepository;
    const reports = Array.from({ length: WARM_UP_RUNS + RUNS }, (_, run) =>
      buildReport(run, changed),
    );
    const { listener, announced } = buildAnnouncementRecorder();
    const at = new Date().toISOString();
    const timing = yield* measure((run) => {
      const { diskUsage } = reports[run]!;
      return withTransaction(
        sql,
        Effect.all([
          workspaces.recordDiskUsage(RUNNER, diskUsage.workspaces),
          diskUsage.runner === null
            ? Effect.void
            : runners.recordDiskUsage(RUNNER, diskUsage.runner, at),
        ]),
      ).pipe(Effect.provide(listener));
    });
    const workspaceChanges = announced.filter(
      (change) => change._tag === "record" && change.topic === "workspace",
    ).length;
    return { timing, announcedPerRun: workspaceChanges / (WARM_UP_RUNS + RUNS) };
  });

const format = (timing: Timing) =>
  `median ${timing.medianMs.toFixed(2)} ms, max ${timing.maxMs.toFixed(2)} ms`;

describe.runIf(SPEED_TESTS_ENABLED)("a disk usage report of 2,000 entries", () => {
  it("is read and written in bounded time, and announces only the changed workspaces", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* seed;
        const raw = JSON.stringify(buildReport(0, CHANGED_ENTRIES));
        const read = yield* measure(() => readFrame(raw));
        const fewChanged = yield* measureWrite(CHANGED_ENTRIES);
        const allChanged = yield* measureWrite(MAX_MEASURED_WORKSPACES);
        return { frameBytes: Buffer.byteLength(raw), read, fewChanged, allChanged };
      }).pipe(Effect.provide(TestDatabase)),
    );

    process.stderr.write(
      [
        `Disk usage report of ${String(MAX_MEASURED_WORKSPACES)} entries, median and max of ${String(RUNS)}:`,
        `  reading the frame (${String(result.frameBytes)} bytes): ${format(result.read)}`,
        `  writing, ${String(CHANGED_ENTRIES)} changed (${String(result.fewChanged.announcedPerRun)} announced): ${format(result.fewChanged.timing)}`,
        `  writing, all changed (${String(result.allChanged.announcedPerRun)} announced): ${format(result.allChanged.timing)}`,
      ].join("\n") + "\n",
    );
    expect(result.fewChanged.announcedPerRun).toBe(CHANGED_ENTRIES);
    expect(result.allChanged.announcedPerRun).toBe(MAX_MEASURED_WORKSPACES);
    expect(result.read.medianMs).toBeLessThan(DECODE_CEILING_MS);
    expect(result.fewChanged.timing.medianMs).toBeLessThan(WRITE_CEILING_MS);
  });
});
