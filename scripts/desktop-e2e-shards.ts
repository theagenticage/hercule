#!/usr/bin/env bun
/**
 * Splits the desktop end-to-end test files into shards of about equal run
 * time, so that CI can run each shard on a runner of its own.
 *
 *   bun run scripts/desktop-e2e-shards.ts 2/8
 *
 * prints the files of shard 2 of 8, one path per line, ready to pass to
 * `pnpm test:desktop:container`. The shards are computed from the files in
 * `e2e/desktop` and the run times recorded in
 * `desktop-e2e-shard-weights.json` (refreshed by
 * `update-desktop-e2e-shard-weights.ts`). Every file is in exactly one shard.
 *
 * Vitest's own `--shard` splits by file name, which leaves one shard with
 * the long files. A sequencer that weighs files cannot do it here either:
 * Vitest has one sequencer for all its projects, and the other CI jobs shard
 * by name with `--shard`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPOSITORY_ROOT = join(import.meta.dirname, "..");
const TEST_FOLDER = "e2e/desktop";
/** Where the recorded run times are kept. */
export const WEIGHTS_PATH = join(import.meta.dirname, "desktop-e2e-shard-weights.json");

/** Run times in seconds, by file path relative to the repository root. */
export type ShardWeights = Readonly<Record<string, number>>;

/**
 * Returns the paths of the desktop end-to-end test files, relative to the
 * repository root and sorted by name.
 */
export function listDesktopE2eFiles(): ReadonlyArray<string> {
  return readdirSync(join(REPOSITORY_ROOT, TEST_FOLDER))
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => `${TEST_FOLDER}/${name}`)
    .sort();
}

/** Reads the recorded run times of the test files. Fails when the file is missing or not JSON. */
export function readShardWeights(): ShardWeights {
  return JSON.parse(readFileSync(WEIGHTS_PATH, "utf8")) as ShardWeights;
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
 * keeps the shards close to equal. Ties break by file name, so the same
 * input always gives the same shards.
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
    const lightest = shards.reduce((least, shard) => (shard.weight < least.weight ? shard : least));
    lightest.weight += weight;
    lightest.files.push(file);
  }
  return shards.map((shard) => shard.files.toSorted());
}

/**
 * Parses `<index>/<count>`, such as `2/8`, with the index counted from 1.
 * Fails when the text is not in that form or the index is outside the count.
 */
export function parseShardSpecifier(text: string): { index: number; count: number } {
  const match = /^(\d+)\/(\d+)$/.exec(text);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (match === null || index < 1 || index > count) {
    throw new Error(
      `The shard must be written <index>/<count> with 1 <= index <= count, such as 2/8, not "${text}".`,
    );
  }
  return { index, count };
}

if (import.meta.main) {
  try {
    const { index, count } = parseShardSpecifier(process.argv[2] ?? "");
    const files = planShards(listDesktopE2eFiles(), readShardWeights(), count)[index - 1]!;
    // An empty list would make `vitest run` start every file, not none.
    if (files.length === 0)
      throw new Error(`Shard ${index}/${count} has no files: there are fewer files than shards.`);
    console.log(files.join("\n"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
