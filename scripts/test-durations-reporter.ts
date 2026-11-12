/**
 * A Vitest reporter that writes how long each test file took to
 * `test-durations.json`, for `update-test-shard-weights.ts`. CI adds it to
 * every shard of `pnpm test:node` and `pnpm test:react`:
 *
 *   pnpm test:react --shard=2/4 --reporter=default --reporter=./scripts/test-durations-reporter.ts
 *
 * A file's time is all the time it holds a worker: setting up its
 * environment, importing its modules, and running its tests. The JSON
 * reporter's times hold only the tests, which is half of the cost of a small
 * React file.
 */
import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Reporter, TestModule, TestRunEndReason, Vitest } from "vitest/node";
import type { ShardWeights } from "./shard-plan";
import { buildWeightKey } from "./test-shards";

/** Where the reporter writes, at the repository root. */
export const DURATIONS_FILE = "test-durations.json";

/** What one shard of a CI run wrote. */
export interface DurationsReport {
  /** The shard, counted from 1; 1 of 1 for a run without `--shard`. */
  readonly index: number;
  /** The number of shards in the run. */
  readonly count: number;
  /** Whether every test of the shard passed. */
  readonly passed: boolean;
  /** Each file's time in seconds, rounded to a tenth, by `buildWeightKey`. */
  readonly durations: ShardWeights;
}

export default class TestDurationsReporter implements Reporter {
  private vitest!: Vitest;
  private readonly durations: Record<string, number> = {};

  onInit(vitest: Vitest): void {
    this.vitest = vitest;
  }

  onTestModuleEnd(testModule: TestModule): void {
    const diagnostic = testModule.diagnostic();
    const milliseconds =
      diagnostic.environmentSetupDuration +
      diagnostic.prepareDuration +
      diagnostic.collectDuration +
      diagnostic.setupDuration +
      diagnostic.duration;
    const path = relative(this.vitest.config.root, testModule.moduleId);
    this.durations[buildWeightKey(testModule.project.name, path)] =
      Math.round(milliseconds / 100) / 10;
  }

  onTestRunEnd(
    _testModules: ReadonlyArray<TestModule>,
    _errors: ReadonlyArray<unknown>,
    reason: TestRunEndReason,
  ): void {
    const { shard, root } = this.vitest.config;
    const report: DurationsReport = {
      index: shard?.index ?? 1,
      count: shard?.count ?? 1,
      passed: reason === "passed",
      durations: this.durations,
    };
    writeFileSync(join(root, DURATIONS_FILE), `${JSON.stringify(report, null, 2)}\n`);
  }
}
