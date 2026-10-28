import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALL_THEMES } from "../src/renderer/specimens/sheet-themes.ts";
import { parseThemeList } from "./ui-screens.ts";

describe("parseThemeList", () => {
  it("returns the names in the order given", () => {
    expect(parseThemeList("nile,end-house")).toEqual(["nile", "end-house"]);
  });

  it("fails on an unknown theme and lists the valid ones", () => {
    expect(() => parseThemeList("nile,paris")).toThrow(
      `Unknown theme "paris" in --themes. The themes are ${ALL_THEMES.join(", ")}.`,
    );
  });

  it("fails on an empty list and on a theme named twice", () => {
    expect(() => parseThemeList("")).toThrow(/Unknown theme ""/);
    expect(() => parseThemeList("nile,nile")).toThrow(/"nile" appears twice/);
  });
});

describe("the shards of the CI ui-metrics job", () => {
  it("hold every theme exactly once", () => {
    const workflow = readFileSync(
      new URL("../../../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    const matrix = workflow.match(/^ {6}matrix:\n {8}themes:\n((?: {10}- .+\n)+)/m);
    expect(matrix, "the ui-metrics job's matrix of themes").not.toBeNull();
    const themesOfShards = matrix![1]!
      .split("\n")
      .filter((line) => line !== "")
      .flatMap((line) => parseThemeList(line.replace(/^ +- /, "")));

    expect([...themesOfShards].sort()).toEqual([...ALL_THEMES].sort());
  });
});
