#!/usr/bin/env bun
/**
 * Updates `test-shard-weights.json` with the run times the shards of one CI
 * run recorded. CI runs it after every run on `main`, then saves the file to
 * the Actions cache:
 *
 *   bun run scripts/update-test-shard-weights.ts <folder>
 *
 * `<folder>` holds one `test-durations-<suite>-<shard>` folder per shard, as
 * `actions/download-artifact` writes them, each with the `test-durations.json`
 * of `test-durations-reporter.ts`. The file is changed one suite at a time:
 *
 * - A suite whose shards all uploaded a report once, and all passed, replaces
 *   every weight of its projects. A file that is gone loses its weight.
 * - Any other suite keeps the weights it had, and the script says why. A test
 *   that failed or timed out says nothing about how long its file takes, and
 *   a missing shard would drop the weights of its files.
 *
 * Exits with 1, writing nothing, when no suite could be updated.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DURATIONS_FILE, type DurationsReport } from "./test-durations-reporter";
import { readTestShardWeights, type ShardWeights, TEST_WEIGHTS_PATH } from "./test-shards";

/** The suites CI shards, each in a job of its own. */
export const SUITES = ["node", "react", "desktop"] as const;

/** The report one shard uploaded, and the suite it belongs to. */
export interface SuiteShardReport {
  readonly suite: string;
  readonly report: DurationsReport;
}

/** The weights after an update, and why each suite that was not updated kept its weights. */
export interface WeightsUpdate {
  readonly weights: ShardWeights;
  readonly updatedSuites: ReadonlyArray<string>;
  readonly refusals: ReadonlyArray<string>;
}

/**
 * Returns why the reports of one suite cannot update the weights, or
 * undefined when they can: when the suite has no reports, its shards disagree
 * on the number of shards, a shard is missing or appears twice, or a shard
 * has a failed test.
 */
function findRefusal(suite: string, shards: ReadonlyArray<DurationsReport>): string | undefined {
  const count = shards[0]?.count;
  if (count === undefined) return `The ${suite} tests uploaded no reports.`;
  if (shards.some((shard) => shard.count !== count)) {
    return `The shards of the ${suite} tests disagree on the number of shards.`;
  }
  const indices = shards.map((shard) => shard.index).toSorted((a, b) => a - b);
  if (indices.length !== count || indices.some((index, position) => index !== position + 1)) {
    return `The ${suite} tests have shards ${indices.join(", ")}, not each of 1 to ${count} once.`;
  }
  const failed = shards.find((shard) => !shard.passed);
  if (failed !== undefined) return `Shard ${failed.index} of the ${suite} tests has a failed test.`;
  return undefined;
}

/**
 * Returns `previous` with the weights of every suite whose reports qualify
 * replaced by the run times in those reports, sorted by name.
 */
export function updateWeights(
  previous: ShardWeights,
  reports: ReadonlyArray<SuiteShardReport>,
): WeightsUpdate {
  const weights: Record<string, number> = { ...previous };
  const updatedSuites: Array<string> = [];
  const refusals: Array<string> = [];
  for (const suite of SUITES) {
    const shards = reports.filter((report) => report.suite === suite).map(({ report }) => report);
    const refusal = findRefusal(suite, shards);
    if (refusal !== undefined) {
      refusals.push(refusal);
      continue;
    }
    const durations = Object.assign({}, ...shards.map((shard) => shard.durations)) as ShardWeights;
    const projects = new Set(Object.keys(durations).map((key) => key.split(":")[0]));
    for (const key of Object.keys(weights)) {
      if (projects.has(key.split(":")[0])) delete weights[key];
    }
    Object.assign(weights, durations);
    updatedSuites.push(suite);
  }
  return {
    weights: Object.fromEntries(Object.entries(weights).toSorted(([a], [b]) => (a < b ? -1 : 1))),
    updatedSuites,
    refusals,
  };
}

/** Reads the report in each `test-durations-<suite>-<shard>` folder under `folder`. */
function readReports(folder: string): Array<SuiteShardReport> {
  return readdirSync(folder)
    .filter((name) => existsSync(join(folder, name, DURATIONS_FILE)))
    .map((name) => ({
      suite: name.replace(/^test-durations-/, "").replace(/-\d+$/, ""),
      report: JSON.parse(
        readFileSync(join(folder, name, DURATIONS_FILE), "utf8"),
      ) as DurationsReport,
    }));
}

if (import.meta.main) {
  const folder = process.argv[2];
  if (folder === undefined) {
    console.error("Usage: bun run scripts/update-test-shard-weights.ts <folder>");
    process.exit(1);
  }
  const { weights, updatedSuites, refusals } = updateWeights(
    readTestShardWeights(),
    readReports(folder),
  );
  for (const refusal of refusals)
    console.warn(`${refusal} The weights of that suite are unchanged.`);
  if (updatedSuites.length === 0) {
    console.error("No suite's weights could be updated; the weights file is unchanged.");
    process.exit(1);
  }
  writeFileSync(TEST_WEIGHTS_PATH, `${JSON.stringify(weights, null, 2)}\n`);
  console.log(`Updated the weights of the ${updatedSuites.join(", ")} tests.`);
}
