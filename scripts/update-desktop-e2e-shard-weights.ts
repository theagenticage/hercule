#!/usr/bin/env bun
/**
 * Refreshes `desktop-e2e-shard-weights.json` from the shards of one finished
 * CI run.
 *
 *   bun run scripts/update-desktop-e2e-shard-weights.ts <run id>
 *
 * It downloads the artifacts named `desktop-e2e-report-*` of the run with
 * `gh`, and writes each file's run time. The weights come from CI, where the
 * shards run, because a laptop's timings are not a runner's.
 *
 * It writes nothing, and says why, unless the run qualifies. It judges the
 * run's desktop reports and nothing else: other jobs of the run may have
 * failed. The run must be:
 *
 * - completed;
 * - every shard of the run uploaded its report and its plan, once;
 * - passing in every shard's report, because a test that failed or timed out
 *   says nothing about how long its file takes;
 * - the reports hold every desktop test file of the commit the run tested,
 *   each exactly once. The shards record that commit's file list in their
 *   plans, so the check does not depend on the files in this checkout.
 *
 * Without that, a shard that failed before it ran any test would drop the
 * weights of its files.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ShardRecord, WEIGHTS_PATH } from "./desktop-e2e-shards";
import type { ShardWeights } from "./shard-plan";

/** The part of a Vitest JSON report that this script reads. */
export interface VitestReport {
  readonly success: boolean;
  readonly testResults: ReadonlyArray<{ name: string; startTime: number; endTime: number }>;
}

/** What one shard of a run uploaded: its plan and its Vitest report. */
export interface ShardArtifact {
  readonly record: ShardRecord;
  readonly report: VitestReport;
}

/**
 * Returns a file's path relative to the repository root. A report names its
 * files by absolute path, which differs between the container and a laptop,
 * so the path is cut at `e2e/desktop/`. Fails when the path is not under it.
 */
function cutToRepositoryPath(reportedPath: string): string {
  const start = reportedPath.lastIndexOf("e2e/desktop/");
  if (start === -1) throw new Error(`${reportedPath} is not a desktop end-to-end test file.`);
  return reportedPath.slice(start);
}

/**
 * Returns each test file's run time in seconds, rounded to a tenth, sorted by
 * path, from the artifacts of all shards of one run. Fails, saying why, when
 * the artifacts are not a complete and passing run:
 *
 * - the shards do not agree on the number of shards or on the files of the
 *   checkout, or one shard is missing or appears twice;
 * - a shard's report has a failed test;
 * - a shard's report holds other files than its plan says it ran;
 * - two shards report the same file;
 * - the files of the reports are not exactly the files of the checkout.
 */
export function readWeightsFromShards(shards: ReadonlyArray<ShardArtifact>): ShardWeights {
  const first = shards[0]?.record;
  if (first === undefined) throw new Error("The run has no shard artifacts.");
  const { count, allFiles } = first;
  const indices = shards.map((shard) => shard.record.index).toSorted((a, b) => a - b);
  if (indices.length !== count || indices.some((index, position) => index !== position + 1)) {
    throw new Error(
      `The run has shards ${indices.join(", ")}, not each of 1 to ${count} once. A shard did not upload its report, or the run is not finished.`,
    );
  }
  if (
    shards.some(
      (shard) => shard.record.count !== count || shard.record.allFiles.join() !== allFiles.join(),
    )
  ) {
    throw new Error("The shards disagree on the number of shards or on the files of the checkout.");
  }
  const reported = new Map<string, number>();
  for (const { record, report } of shards) {
    if (!report.success) {
      throw new Error(
        `Shard ${record.index} has a failed test. Pick a run in which every test passed.`,
      );
    }
    const ran = report.testResults.map((file) => cutToRepositoryPath(file.name));
    if (ran.toSorted().join() !== record.files.toSorted().join()) {
      throw new Error(`Shard ${record.index} reported other files than it was planned to run.`);
    }
    for (const file of report.testResults) {
      const path = cutToRepositoryPath(file.name);
      if (reported.has(path)) throw new Error(`${path} is reported by more than one shard.`);
      reported.set(path, Math.round((file.endTime - file.startTime) / 100) / 10);
    }
  }
  const missing = allFiles.filter((file) => !reported.has(file));
  if (missing.length > 0 || reported.size !== allFiles.length) {
    throw new Error(
      `The reports do not hold exactly the ${allFiles.length} test files of the checkout. Missing: ${missing.join(", ") || "none"}.`,
    );
  }
  return Object.fromEntries([...reported].toSorted(([a], [b]) => (a < b ? -1 : 1)));
}

/** Reads the plan and the report of each `desktop-e2e-report-*` folder under `folder`. */
function readShardArtifacts(folder: string): Array<ShardArtifact> {
  return readdirSync(folder).map((name) => ({
    record: JSON.parse(readFileSync(join(folder, name, "plan.json"), "utf8")) as ShardRecord,
    report: JSON.parse(readFileSync(join(folder, name, "report.json"), "utf8")) as VitestReport,
  }));
}

/** Runs `gh` and returns its output. Fails with `gh`'s own message when it fails. */
function runGh(args: ReadonlyArray<string>): string {
  const result = spawnSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (result.status !== 0) throw new Error(`gh ${args.join(" ")} failed.`);
  return result.stdout;
}

if (import.meta.main) {
  const runId = process.argv[2];
  if (runId === undefined || !/^\d+$/.test(runId)) {
    console.error("Usage: bun run scripts/update-desktop-e2e-shard-weights.ts <run id>");
    process.exit(1);
  }
  const folder = mkdtempSync(join(tmpdir(), "hercule-desktop-e2e-reports-"));
  try {
    const status = runGh(["run", "view", runId, "--json", "status", "--jq", ".status"]).trim();
    if (status !== "completed") throw new Error(`Run ${runId} is ${status}, not completed.`);
    runGh(["run", "download", runId, "--pattern", "desktop-e2e-report-*", "--dir", folder]);
    const shards = readShardArtifacts(folder);
    writeFileSync(WEIGHTS_PATH, `${JSON.stringify(readWeightsFromShards(shards), null, 2)}\n`);
    console.log(`Wrote ${WEIGHTS_PATH} from ${shards.length} shards of run ${runId}.`);
  } catch (error) {
    console.error(
      `${error instanceof Error ? error.message : String(error)}\nThe weights file is unchanged.`,
    );
    process.exitCode = 1;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
