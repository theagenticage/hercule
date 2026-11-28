import { describe, expect, it } from "vitest";
import type { TestSpecification } from "vitest/node";
import type { DurationsReport } from "./test-durations-reporter";
import { planShards, selectShardSpecs } from "./test-shards";
import { type SuiteShardReport, updateWeights } from "./update-test-shard-weights";

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

  it("spreads files that weigh the same over every shard, as when no weight is recorded", () => {
    const files = ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts", "e.test.ts"];
    expect(planShards(files, {}, 3).map((shard) => shard.length)).toEqual([2, 2, 1]);
  });

  it("refuses a shard count that is not a positive whole number", () => {
    expect(() => planShards(["a.test.ts"], {}, 0)).toThrow(/positive whole number/);
    expect(() => planShards(["a.test.ts"], {}, 1.5)).toThrow(/positive whole number/);
  });
});

describe("selectShardSpecs", () => {
  it("weighs each spec by its project and its path from the root, and puts each in one shard", () => {
    const specs = [
      { project: { name: "react" }, moduleId: "/repo/apps/web/src/long.test.tsx" },
      { project: { name: "react" }, moduleId: "/repo/apps/web/src/a.test.tsx" },
      { project: { name: "node" }, moduleId: "/repo/apps/web/src/long.test.tsx" },
      { project: { name: "react" }, moduleId: "/repo/apps/web/src/b.test.tsx" },
    ] as Array<TestSpecification>;
    const weights = {
      "react:apps/web/src/long.test.tsx": 60,
      "react:apps/web/src/a.test.tsx": 20,
      "react:apps/web/src/b.test.tsx": 20,
      "node:apps/web/src/long.test.tsx": 1,
    };

    const shards = [1, 2].map((index) =>
      selectShardSpecs(specs, "/repo", { index, count: 2 }, weights),
    );

    expect(shards.flat()).toHaveLength(specs.length);
    expect(new Set(shards.flat())).toEqual(new Set(specs));
    expect(shards[0]).toEqual([specs[0]]);
  });
});

describe("updateWeights", () => {
  /** A passing report of shard `index` of 2 of `suite`, whose one file took `seconds`. */
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
  const passingSuite = (suite: string) => [buildReport(suite, 2), buildReport(suite, 1)];

  it("replaces the weights of each suite whose shards all passed, and drops a file that is gone", () => {
    const previous = {
      "react:gone.test.ts": 9,
      "node:file-1.test.ts": 9,
      "desktop:file-1.test.ts": 9,
    };
    const reports = [...passingSuite("react"), ...passingSuite("node"), ...passingSuite("desktop")];

    expect(updateWeights(previous, reports)).toEqual({
      weights: {
        "desktop:file-1.test.ts": 1.5,
        "desktop:file-2.test.ts": 1.5,
        "node:file-1.test.ts": 1.5,
        "node:file-2.test.ts": 1.5,
        "react:file-1.test.ts": 1.5,
        "react:file-2.test.ts": 1.5,
      },
      updatedSuites: ["node", "react", "desktop"],
      refusals: [],
    });
  });

  it.each([
    ["has no reports", [], /desktop tests uploaded no reports/],
    ["is missing a shard", [buildReport("desktop", 1)], /shards 1, not each of 1 to 2 once/],
    [
      "has a shard twice",
      [buildReport("desktop", 1), buildReport("desktop", 1)],
      /shards 1, 1, not each/,
    ],
    [
      "disagrees on the number of shards",
      [buildReport("desktop", 1), buildReport("desktop", 2, { count: 3 })],
      /disagree on the number of shards/,
    ],
    [
      "has a failed test",
      [buildReport("desktop", 1), buildReport("desktop", 2, { passed: false })],
      /Shard 2 of the desktop tests has a failed test/,
    ],
  ])(
    "keeps the weights of a suite that %s, and still updates the others",
    (_case, desktop, refusal) => {
      const previous = { "desktop:old.test.ts": 9 };
      const update = updateWeights(previous, [
        ...passingSuite("node"),
        ...passingSuite("react"),
        ...desktop,
      ]);

      expect(update.updatedSuites).toEqual(["node", "react"]);
      expect(update.weights["desktop:old.test.ts"]).toBe(9);
      expect(update.refusals).toEqual([expect.stringMatching(refusal)]);
    },
  );
});
