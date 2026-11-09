import { describe, expect, it } from "vitest";
import {
  listDesktopE2eFiles,
  parseShardSpecifier,
  planShards,
  readShardWeights,
} from "./desktop-e2e-shards";
import { readWeightsFromReports } from "./update-desktop-e2e-shard-weights";

describe("planShards", () => {
  it("puts every desktop test file in exactly one shard, for any number of shards", () => {
    const files = listDesktopE2eFiles();
    expect(files.length).toBeGreaterThan(0);
    for (let count = 1; count <= 12; count++) {
      const planned = planShards(files, readShardWeights(), count).flat();
      expect(planned.toSorted()).toEqual(files);
    }
  });

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

describe("readWeightsFromReports", () => {
  it("names each file by its path from e2e/desktop, in seconds rounded to a tenth, across reports", () => {
    const weights = readWeightsFromReports([
      {
        success: true,
        testResults: [{ name: "/repo/e2e/desktop/b.test.ts", startTime: 1000, endTime: 13_340 }],
      },
      {
        success: true,
        testResults: [
          { name: "/home/me/hercule/e2e/desktop/a.test.ts", startTime: 0, endTime: 49 },
        ],
      },
    ]);
    expect(weights).toEqual({ "e2e/desktop/a.test.ts": 0, "e2e/desktop/b.test.ts": 12.3 });
  });
});
