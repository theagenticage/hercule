/**
 * Splits the files of `pnpm test:node` and `pnpm test:react` into shards of
 * about equal run time, for `vitest run --shard=<index>/<count>`.
 *
 * Vitest's own `--shard` splits by a hash of the file name into shards with
 * the same number of files. A few React files take minutes and most take a
 * second, so the shard that draws the long files runs minutes longer than
 * the others. `WeighedShardSequencer` replaces that split with `planShards`,
 * which weighs each file by the run time recorded for it in
 * `test-shard-weights.json`. That file is refreshed from a CI run with
 * `bun run scripts/update-test-shard-weights.ts <run id>`, and the
 * run times come from `test-durations-reporter.ts`.
 */
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { planShards, type ShardWeights } from "./shard-plan.ts";

/** Where the recorded run times are kept. */
export const TEST_WEIGHTS_PATH = join(import.meta.dirname, "test-shard-weights.json");

/**
 * Returns the name a test file's run time is recorded under:
 * `<project>:<path from the repository root>`, such as
 * `react:apps/web/src/app/router.test.tsx`. The project is part of the name
 * because a few files run in two projects, at a different cost in each.
 */
export const buildWeightKey = (project: string, path: string): string => `${project}:${path}`;

/** Reads the recorded run times. Fails when the file is missing or not JSON. */
export function readTestShardWeights(): ShardWeights {
  return JSON.parse(readFileSync(TEST_WEIGHTS_PATH, "utf8")) as ShardWeights;
}

/**
 * The sequencer of `vitest.config.ts`. It changes only how `--shard` splits
 * the files; the order inside a shard is Vitest's own.
 */
export class WeighedShardSequencer extends BaseSequencer {
  /** Returns the files of this run's shard, planned by `planShards` over every file of the run. */
  override shard(specs: Array<TestSpecification>): Promise<Array<TestSpecification>> {
    const { root, shard } = this.ctx.config;
    const specsByKey = new Map(
      specs.map((spec) => [buildWeightKey(spec.project.name, relative(root, spec.moduleId)), spec]),
    );
    const planned = planShards([...specsByKey.keys()], readTestShardWeights(), shard!.count);
    return Promise.resolve(planned[shard!.index - 1]!.map((key) => specsByKey.get(key)!));
  }
}
