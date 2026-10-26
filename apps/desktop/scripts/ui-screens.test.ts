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
