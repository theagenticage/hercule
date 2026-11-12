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
 *   bun run scripts/desktop-e2e-shards.ts 2/8 --record plan.json
 *
 * also writes a `ShardRecord` to `plan.json`: which shard this is, its files,
 * and every file of the checkout. CI uploads it beside the shard's Vitest
 * report, so the weights refresh can check that a run's reports cover the
 * files of the commit that run tested.
 *
 * Vitest's own `--shard` splits by file name, which leaves one shard with
 * the long files. The other test suites are split by run time inside Vitest
 * (`test-shards.ts`); this suite is planned out here because each shard also
 * records which files it ran, which the weights refresh checks.
 */
import { globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { planShards, type ShardWeights } from "./shard-plan";

const REPOSITORY_ROOT = join(import.meta.dirname, "..");
const TEST_FOLDER = "e2e/desktop";
/** Where the recorded run times are kept. */
export const WEIGHTS_PATH = join(import.meta.dirname, "desktop-e2e-shard-weights.json");

/** What a shard of a CI run recorded about its plan, uploaded beside its Vitest report. */
export interface ShardRecord {
  /** This shard, counted from 1. */
  readonly index: number;
  /** The number of shards in the run. */
  readonly count: number;
  /** The files this shard ran. */
  readonly files: ReadonlyArray<string>;
  /** Every desktop test file of the checkout the shard ran on. */
  readonly allFiles: ReadonlyArray<string>;
}

/**
 * Returns the paths of the desktop end-to-end test files, relative to the
 * repository root and sorted by name: every `*.test.ts` under `e2e/desktop`,
 * in subfolders too. This is the pattern of the `desktop` project in
 * `vitest.config.ts`, and a test compares the two.
 */
export function listDesktopE2eFiles(): ReadonlyArray<string> {
  return globSync(`${TEST_FOLDER}/**/*.test.ts`, { cwd: REPOSITORY_ROOT }).sort();
}

/** Reads the recorded run times of the test files. Fails when the file is missing or not JSON. */
export function readShardWeights(): ShardWeights {
  return JSON.parse(readFileSync(WEIGHTS_PATH, "utf8")) as ShardWeights;
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
    const [, , specifier = "", flag, recordPath] = process.argv;
    if (flag !== undefined && (flag !== "--record" || recordPath === undefined)) {
      throw new Error(
        "Usage: bun run scripts/desktop-e2e-shards.ts <index>/<count> [--record <path>]",
      );
    }
    const { index, count } = parseShardSpecifier(specifier);
    const allFiles = listDesktopE2eFiles();
    const files = planShards(allFiles, readShardWeights(), count)[index - 1]!;
    // An empty list would make `vitest run` start every file, not none.
    if (files.length === 0)
      throw new Error(`Shard ${index}/${count} has no files: there are fewer files than shards.`);
    if (recordPath !== undefined) {
      const record: ShardRecord = { index, count, files, allFiles };
      mkdirSync(dirname(recordPath), { recursive: true });
      writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    }
    console.log(files.join("\n"));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
