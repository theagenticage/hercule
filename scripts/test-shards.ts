/**
 * Splits the test files of a sharded CI job into shards of about equal run
 * time, for `vitest run --shard=<index>/<count>`. CI shards three suites this
 * way: `pnpm test:node`, `pnpm test:react` and the desktop end-to-end tests.
 *
 * Vitest's own `--shard` splits by a hash of the file name into shards with
 * the same number of files. A few files take minutes and most take a second,
 * so the shard that draws the long files runs minutes longer than the others.
 * `WeighedShardSequencer` replaces that split with `planShards`, which weighs
 * each file by the run time recorded for it in `test-shard-weights.json` at
 * the repository root.
 *
 * Nobody edits that file and git does not track it. In CI, every shard
 * records its files' run times (`test-durations-reporter.ts`); after a green
 * run on `main`, `update-test-shard-weights.ts` merges them and the workflow
 * saves the result to the Actions cache. Each later run restores the newest
 * copy once and hands that one copy to all its shards. So every shard plans
 * from the same weights, and together they run every file exactly once.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

/** Run times in seconds, by `buildWeightKey`. */
export type ShardWeights = Readonly<Record<string, number>>;

/** Where the recorded run times are read from and written to. */
export const TEST_WEIGHTS_PATH = join(import.meta.dirname, "..", "test-shard-weights.json");

/**
 * Returns the name a test file's run time is recorded under:
 * `<project>:<path from the repository root>`, such as
 * `react:apps/web/src/app/router.test.tsx`. The project is part of the name
 * because a few files run in two projects, at a different cost in each.
 */
export const buildWeightKey = (project: string, path: string): string => `${project}:${path}`;

/**
 * Reads the recorded run times. Returns no weights when the file is missing,
 * such as on a laptop or before CI has saved any. Fails when the file is not
 * JSON.
 */
export function readTestShardWeights(): ShardWeights {
  if (!existsSync(TEST_WEIGHTS_PATH)) return {};
  return JSON.parse(readFileSync(TEST_WEIGHTS_PATH, "utf8")) as ShardWeights;
}

/** Returns the median of a list of numbers; 0 for an empty list. */
function computeMedian(numbers: ReadonlyArray<number>): number {
  if (numbers.length === 0) return 0;
  const sorted = numbers.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Splits the files into `count` shards and returns them, each sorted by name.
 * Fails when `count` is not a positive whole number.
 *
 * A file's weight is its recorded run time in `weights`. A file with no
 * record, such as one added since the weights were refreshed, weighs the
 * median of the recorded ones: neither free nor assumed long. Files are placed
 * longest first, each into the shard with the least weight so far, which
 * keeps the shards close to equal. Between shards of equal weight, the one
 * with the fewest files wins, so files that weigh nothing, or that all weigh
 * the same, are spread over every shard. Ties between files break by name,
 * so the same input always gives the same shards.
 *
 * Every file is in exactly one shard, whatever the weights say: a file the
 * weights do not know is planned, and a weight for a file that is gone is
 * ignored.
 */
export function planShards(
  files: ReadonlyArray<string>,
  weights: ShardWeights,
  count: number,
): ReadonlyArray<ReadonlyArray<string>> {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`The number of shards must be a positive whole number, not ${count}.`);
  }
  const unrecordedWeight = computeMedian(
    files.flatMap((file) => (file in weights ? [weights[file]!] : [])),
  );
  const weighed = files
    .map((file) => ({ file, weight: weights[file] ?? unrecordedWeight }))
    .toSorted((a, b) => b.weight - a.weight || (a.file < b.file ? -1 : 1));

  const shards = Array.from({ length: count }, () => ({ weight: 0, files: [] as Array<string> }));
  for (const { file, weight } of weighed) {
    const lightest = shards.reduce((least, shard) =>
      shard.weight < least.weight ||
      (shard.weight === least.weight && shard.files.length < least.files.length)
        ? shard
        : least,
    );
    lightest.weight += weight;
    lightest.files.push(file);
  }
  return shards.map((shard) => shard.files.toSorted());
}

/**
 * Returns the specs of shard `index` of `count`, planned by `planShards` over
 * all `specs`. A spec is weighed by its key, `buildWeightKey` of its project
 * and its path from `root`.
 */
export function selectShardSpecs(
  specs: ReadonlyArray<TestSpecification>,
  root: string,
  { index, count }: { readonly index: number; readonly count: number },
  weights: ShardWeights,
): Array<TestSpecification> {
  const specsByKey = new Map(
    specs.map((spec) => [buildWeightKey(spec.project.name, relative(root, spec.moduleId)), spec]),
  );
  return planShards([...specsByKey.keys()], weights, count)[index - 1]!.map((key) =>
    specsByKey.get(key)!,
  );
}

/**
 * The sequencer of `vitest.config.ts`. It changes only how `--shard` splits
 * the files; the order inside a shard is Vitest's own.
 */
export class WeighedShardSequencer extends BaseSequencer {
  /** Returns the files of this run's shard, split by the recorded run times. */
  override shard(specs: Array<TestSpecification>): Promise<Array<TestSpecification>> {
    const weights = readTestShardWeights();
    if (Object.keys(weights).length === 0) {
      console.warn(
        `No run times recorded in ${TEST_WEIGHTS_PATH}: the shards get about the same number of files each.`,
      );
    }
    const { root, shard } = this.ctx.config;
    return Promise.resolve(selectShardSpecs(specs, root, shard!, weights));
  }
}
