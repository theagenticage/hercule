import { describe, expect, it } from "vitest";
import { planShards } from "./shard-plan";

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
