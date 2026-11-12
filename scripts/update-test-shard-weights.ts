#!/usr/bin/env bun
/**
 * Refreshes `test-shard-weights.json` from the shards of one finished CI run.
 *
 *   bun run scripts/update-test-shard-weights.ts <run id>
 *
 * It downloads the artifacts named `test-durations-<suite>-<shard>` of the
 * run with `gh`, and writes each file's run time. The weights come from CI,
 * where the shards run, because a laptop's timings are not a runner's.
 *
 * It writes nothing, and says why, unless the run qualifies. The run must be
 * completed, and for each suite (`node` and `react`) every shard must have
 * uploaded its report once, with every test passed: a test that failed or
 * timed out says nothing about how long its file takes. Other jobs of the run
 * may have failed.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ShardWeights } from "./shard-plan";
import { DURATIONS_FILE, type DurationsReport } from "./test-durations-reporter";
import { TEST_WEIGHTS_PATH } from "./test-shards";

/** The suites whose shards CI runs, each its own job: `pnpm test:node` and `pnpm test:react`. */
export const SUITES = ["node", "react"] as const;

/** The report one shard uploaded, and the suite it belongs to. */
export interface SuiteShardReport {
  readonly suite: string;
  readonly report: DurationsReport;
}

/**
 * Returns the run times of every file, sorted by name, from the reports of
 * all shards of one run. Fails, saying why, when a suite of `SUITES` has no
 * reports, when its shards disagree on the number of shards, when a shard is
 * missing or appears twice, or when a shard has a failed test.
 */
export function readWeightsFromReports(reports: ReadonlyArray<SuiteShardReport>): ShardWeights {
  const weights: Record<string, number> = {};
  for (const suite of SUITES) {
    const shards = reports.filter((report) => report.suite === suite).map(({ report }) => report);
    const count = shards[0]?.count;
    if (count === undefined) throw new Error(`The run has no reports of the ${suite} tests.`);
    if (shards.some((shard) => shard.count !== count)) {
      throw new Error(`The shards of the ${suite} tests disagree on the number of shards.`);
    }
    const indices = shards.map((shard) => shard.index).toSorted((a, b) => a - b);
    if (indices.length !== count || indices.some((index, position) => index !== position + 1)) {
      throw new Error(
        `The ${suite} tests have shards ${indices.join(", ")}, not each of 1 to ${count} once. A shard did not upload its report.`,
      );
    }
    const failed = shards.find((shard) => !shard.passed);
    if (failed !== undefined) {
      throw new Error(
        `Shard ${failed.index} of the ${suite} tests has a failed test. Pick a run in which every test passed.`,
      );
    }
    for (const shard of shards) Object.assign(weights, shard.durations);
  }
  return Object.fromEntries(Object.entries(weights).toSorted(([a], [b]) => (a < b ? -1 : 1)));
}

/** Reads the report in each `test-durations-<suite>-<shard>` folder under `folder`. */
function readReports(folder: string): Array<SuiteShardReport> {
  return readdirSync(folder).map((name) => ({
    suite: name.replace(/^test-durations-/, "").replace(/-\d+$/, ""),
    report: JSON.parse(readFileSync(join(folder, name, DURATIONS_FILE), "utf8")) as DurationsReport,
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
    console.error("Usage: bun run scripts/update-test-shard-weights.ts <run id>");
    process.exit(1);
  }
  const folder = mkdtempSync(join(tmpdir(), "hercule-test-durations-"));
  try {
    const status = runGh(["run", "view", runId, "--json", "status", "--jq", ".status"]).trim();
    if (status !== "completed") throw new Error(`Run ${runId} is ${status}, not completed.`);
    runGh(["run", "download", runId, "--pattern", "test-durations-*", "--dir", folder]);
    const reports = readReports(folder);
    writeFileSync(
      TEST_WEIGHTS_PATH,
      `${JSON.stringify(readWeightsFromReports(reports), null, 2)}\n`,
    );
    console.log(`Wrote ${TEST_WEIGHTS_PATH} from ${reports.length} shards of run ${runId}.`);
  } catch (error) {
    console.error(
      `${error instanceof Error ? error.message : String(error)}\nThe weights file is unchanged.`,
    );
    process.exitCode = 1;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
