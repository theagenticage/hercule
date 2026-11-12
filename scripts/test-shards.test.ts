import { describe, expect, it } from "vitest";
import type { TestSpecification, Vitest } from "vitest/node";
import type { DurationsReport } from "./test-durations-reporter";
import { readTestShardWeights, WeighedShardSequencer } from "./test-shards";
import { readWeightsFromReports, type SuiteShardReport } from "./update-test-shard-weights";

describe("WeighedShardSequencer", () => {
  /** Returns the files of each of `count` shards, as the sequencer splits `keys`. */
  const splitIntoShards = async (keys: ReadonlyArray<string>, count: number) => {
    const specs = keys.map((key) => {
      const [project, path] = key.split(":") as [string, string];
      return { project: { name: project }, moduleId: `/repo/${path}` } as TestSpecification;
    });
    const shards = [];
    for (let index = 1; index <= count; index++) {
      const ctx = { config: { root: "/repo", shard: { index, count } } } as unknown as Vitest;
      const shard = await new WeighedShardSequencer(ctx).shard(specs);
      shards.push(shard.map((spec) => `${spec.project.name}:${spec.moduleId.slice(6)}`));
    }
    return shards;
  };

  it("weighs each file by its recorded run time, and puts every file in exactly one shard", async () => {
    // The heaviest file outweighs the three lightest together, so it gets a
    // shard of its own. With no weight found, every file would weigh the same and
    // the heaviest would share its shard.
    const [heaviest, ...others] = Object.entries(readTestShardWeights())
      .toSorted(([, a], [, b]) => b - a)
      .map(([key]) => key);
    const keys = [heaviest!, ...others.slice(-3), "react:apps/web/src/new.test.tsx"];

    const shards = await splitIntoShards(keys, 2);

    expect(shards.flat().toSorted()).toEqual(keys.toSorted());
    expect(shards.find((shard) => shard.includes(heaviest!))).toEqual([heaviest]);
  });
});

describe("readWeightsFromReports", () => {
  /** A passing report of shard `index` of 2 of `suite`, whose one file took 1.5 seconds. */
  const buildReport = (
    suite: string,
    index: number,
    overrides: Partial<DurationsReport> = {},
  ): SuiteShardReport => ({
    suite,
    report: {
      index,
      count: 2,
      passed: true,
      durations: { [`${suite}:file-${index}.test.ts`]: 1.5 },
      ...overrides,
    },
  });
  const passingRun = (): Array<SuiteShardReport> => [
    buildReport("react", 2),
    buildReport("react", 1),
    buildReport("node", 1),
    buildReport("node", 2),
  ];

  it("merges the files of every shard of every suite, sorted by name", () => {
    expect(readWeightsFromReports(passingRun())).toEqual({
      "node:file-1.test.ts": 1.5,
      "node:file-2.test.ts": 1.5,
      "react:file-1.test.ts": 1.5,
      "react:file-2.test.ts": 1.5,
    });
  });

  it.each([
    ["a suite has no reports", () => passingRun().slice(0, 2), /no reports of the node tests/],
    ["a shard is missing", () => passingRun().slice(1), /react tests have shards 1, not each/],
    [
      "a shard appears twice",
      () => [...passingRun().slice(1), buildReport("react", 1)],
      /react tests have shards 1, 1, not each/,
    ],
    [
      "the shards disagree on their number",
      () => [...passingRun().slice(1), buildReport("react", 1, { count: 3 })],
      /disagree on the number of shards/,
    ],
    [
      "a test failed",
      () => [...passingRun().slice(0, 3), buildReport("node", 2, { passed: false })],
      /Shard 2 of the node tests has a failed test/,
    ],
  ])("refuses the run when %s", (_case, build, message) => {
    expect(() => readWeightsFromReports(build())).toThrow(message);
  });
});
