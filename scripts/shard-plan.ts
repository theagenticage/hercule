/**
 * Splits test files into shards of about equal run time, so that CI can run
 * each shard on a runner of its own. Two suites use it: the desktop
 * end-to-end tests (`desktop-e2e-shards.ts`) and the rest of `pnpm test`
 * (`test-shards.ts`).
 */

/** Run times in seconds, by the name of a test file. */
export type ShardWeights = Readonly<Record<string, number>>;

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
