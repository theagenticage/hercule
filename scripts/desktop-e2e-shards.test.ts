import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  listDesktopE2eFiles,
  parseShardSpecifier,
  planShards,
  readShardWeights,
  type ShardRecord,
} from "./desktop-e2e-shards";
import { readWeightsFromShards, type ShardArtifact } from "./update-desktop-e2e-shard-weights";

const repositoryRoot = join(import.meta.dirname, "..");

describe("the files that are planned", () => {
  it("are exactly the files the desktop project runs, according to Vitest", () => {
    const listing = spawnSync(
      "pnpm",
      ["exec", "vitest", "list", "--project", "desktop", "--filesOnly", "--json"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      },
    );
    expect(listing.status, listing.stderr).toBe(0);
    const listed = (JSON.parse(listing.stdout) as Array<{ file: string }>)
      .map(({ file }) => relative(repositoryRoot, file))
      .sort();
    expect(listed.length).toBeGreaterThan(0);
    expect(listDesktopE2eFiles()).toEqual(listed);
  }, 60_000);

  it("are each in exactly one shard, for any number of shards", () => {
    const files = listDesktopE2eFiles();
    for (let count = 1; count <= 12; count++) {
      const planned = planShards(files, readShardWeights(), count).flat();
      expect(planned.toSorted()).toEqual(files);
    }
  });
});

describe("planShards", () => {
  it("plans a file with no recorded weight, and ignores a weight for a file that is gone", () => {
    const shards = planShards(
      ["a.test.ts", "b.test.ts", "new.test.ts"],
      { "a.test.ts": 3, "b.test.ts": 1, "gone.test.ts": 99 },
      2,
    );
    expect(shards.flat().toSorted()).toEqual(["a.test.ts", "b.test.ts", "new.test.ts"]);
  });

  it("keeps the long files apart", () => {
    const weights = {
      "a.test.ts": 10,
      "b.test.ts": 9,
      "c.test.ts": 3,
      "d.test.ts": 2,
      "e.test.ts": 2,
      "f.test.ts": 2,
    };
    expect(planShards(Object.keys(weights), weights, 2)).toEqual([
      ["a.test.ts", "d.test.ts", "e.test.ts"],
      ["b.test.ts", "c.test.ts", "f.test.ts"],
    ]);
  });

  it("refuses a shard count that is not a positive whole number", () => {
    expect(() => planShards(["a.test.ts"], {}, 0)).toThrow(/positive whole number/);
    expect(() => planShards(["a.test.ts"], {}, 1.5)).toThrow(/positive whole number/);
  });
});

describe("parseShardSpecifier", () => {
  it("reads <index>/<count>", () => {
    expect(parseShardSpecifier("2/8")).toEqual({ index: 2, count: 8 });
  });

  it.each(["", "2", "0/8", "9/8", "a/b", "2/8/1"])("refuses %j", (text) => {
    expect(() => parseShardSpecifier(text)).toThrow(/<index>\/<count>/);
  });
});

describe("readWeightsFromShards", () => {
  const allFiles = [
    "e2e/desktop/a.test.ts",
    "e2e/desktop/nested/b.test.ts",
    "e2e/desktop/c.test.ts",
  ];

  /** A passing shard of a run of two, which ran `files`, with each file taking 1.25 seconds. */
  const buildShard = (
    index: number,
    files: ReadonlyArray<string>,
    overrides: Partial<ShardRecord> = {},
  ): ShardArtifact => ({
    record: { index, count: 2, files, allFiles, ...overrides },
    report: {
      success: true,
      testResults: files.map((file) => ({ name: `/repo/${file}`, startTime: 1000, endTime: 2250 })),
    },
  });
  const passingRun = () => [
    buildShard(1, [allFiles[0]!, allFiles[1]!]),
    buildShard(2, [allFiles[2]!]),
  ];

  it("names each file by its path from e2e/desktop, in seconds rounded to a tenth", () => {
    expect(readWeightsFromShards(passingRun())).toEqual({
      "e2e/desktop/a.test.ts": 1.3,
      "e2e/desktop/c.test.ts": 1.3,
      "e2e/desktop/nested/b.test.ts": 1.3,
    });
  });

  it.each([
    ["no shard uploaded anything", () => [], /no shard artifacts/],
    ["a shard is missing", () => [passingRun()[0]!], /not each of 1 to 2 once/],
    [
      "a shard appears twice",
      () => [passingRun()[0]!, passingRun()[0]!],
      /not each of 1 to 2 once/,
    ],
    [
      "a test failed",
      () => [
        passingRun()[0]!,
        { ...passingRun()[1]!, report: { ...passingRun()[1]!.report, success: false } },
      ],
      /Shard 2 has a failed test/,
    ],
    [
      "the shards saw different files",
      () => [passingRun()[0]!, buildShard(2, [allFiles[2]!], { allFiles: [allFiles[2]!] })],
      /disagree/,
    ],
    [
      "a shard reports a file it was not planned to run",
      () => [passingRun()[0]!, buildShard(2, [allFiles[2]!], { files: [allFiles[0]!] })],
      /other files than it was planned/,
    ],
    [
      "two shards report the same file",
      () => [
        buildShard(1, [allFiles[0]!, allFiles[1]!]),
        buildShard(2, [allFiles[1]!, allFiles[2]!]),
      ],
      /e2e\/desktop\/nested\/b.test.ts is reported by more than one shard/,
    ],
    [
      "a file of the checkout was planned for no shard",
      () => [buildShard(1, [allFiles[0]!]), buildShard(2, [allFiles[2]!])],
      /Missing: e2e\/desktop\/nested\/b.test.ts/,
    ],
  ])("refuses the run when %s", (_case, build, message) => {
    expect(() => readWeightsFromShards(build())).toThrow(message);
  });
});
