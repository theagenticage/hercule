#!/usr/bin/env bun
/**
 * Refreshes `desktop-e2e-shard-weights.json` from the Vitest JSON reports
 * that the shards of one CI run uploaded.
 *
 *   bun run scripts/update-desktop-e2e-shard-weights.ts <run id>
 *
 * It downloads the artifacts named `desktop-e2e-report-*` of the run with
 * `gh`, and writes each file's run time. The weights come from CI, where the
 * shards run, because a laptop's timings are not a runner's. Pick a run in
 * which every test passed: a test that failed or timed out says nothing about
 * how long its file takes.
 *
 * Fails when `gh` fails, the run has no report, or a report has a failed test.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ShardWeights, WEIGHTS_PATH } from "./desktop-e2e-shards";

/** The part of a Vitest JSON report that this script reads. */
export interface VitestReport {
  readonly success: boolean;
  readonly testResults: ReadonlyArray<{ name: string; startTime: number; endTime: number }>;
}

/**
 * Returns each test file's run time in seconds, rounded to a tenth, by path
 * relative to the repository root, sorted by path. A report names its files
 * by absolute path, which differs between the container and a laptop, so the
 * path is cut at `e2e/desktop/`.
 */
export function readWeightsFromReports(reports: ReadonlyArray<VitestReport>): ShardWeights {
  const entries = reports.flatMap((report) =>
    report.testResults.map((file) => {
      const start = file.name.lastIndexOf("e2e/desktop/");
      if (start === -1) throw new Error(`${file.name} is not a desktop end-to-end test file.`);
      return [
        file.name.slice(start),
        Math.round((file.endTime - file.startTime) / 100) / 10,
      ] as const;
    }),
  );
  return Object.fromEntries(entries.toSorted(([a], [b]) => (a < b ? -1 : 1)));
}

if (import.meta.main) {
  const runId = process.argv[2];
  if (runId === undefined || !/^\d+$/.test(runId)) {
    console.error("Usage: bun run scripts/update-desktop-e2e-shard-weights.ts <run id>");
    process.exit(1);
  }
  const folder = mkdtempSync(join(tmpdir(), "hercule-desktop-e2e-reports-"));
  try {
    const download = spawnSync(
      "gh",
      ["run", "download", runId, "--pattern", "desktop-e2e-report-*", "--dir", folder],
      { stdio: "inherit" },
    );
    if (download.status !== 0)
      throw new Error(`gh could not download the reports of run ${runId}.`);
    const reports = readdirSync(folder, { recursive: true, encoding: "utf8" })
      .filter((path) => path.endsWith(".json"))
      .map((path) => JSON.parse(readFileSync(join(folder, path), "utf8")) as VitestReport);
    if (reports.length === 0) throw new Error(`Run ${runId} has no desktop-e2e-report-* artifact.`);
    if (reports.some((report) => !report.success)) {
      throw new Error(`Run ${runId} has a failed test. Pick a run in which every test passed.`);
    }
    writeFileSync(WEIGHTS_PATH, `${JSON.stringify(readWeightsFromReports(reports), null, 2)}\n`);
    console.log(`Wrote ${WEIGHTS_PATH} from ${reports.length} reports.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
