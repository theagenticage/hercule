import { describe, expect, it } from "vitest";
import { MAX_ICON_BYTES, MAX_ICON_PATHS } from "@hercule/plugin-host";
import { checkPluginMark } from "./mark";

describe("checkPluginMark", () => {
  it("returns nothing for a plugin with no mark", () => {
    expect(checkPluginMark(undefined)).toEqual({});
  });

  it("keeps a mark of path data", () => {
    const mark = { paths: ["M8 0C3.58 0 0 3.58 0 8z", "m1.5-2.25 l-.5,1e-1 Z"] };

    expect(checkPluginMark(mark)).toEqual({ mark });
  });

  it("drops a mark with something other than path data", () => {
    const checked = checkPluginMark({ paths: ['M0 0" onload="alert(1)'] });

    expect(checked).toEqual({
      markError:
        "The plugin's mark was left out because one of its paths holds something other than SVG path data.",
    });
  });

  it("drops a mark whose paths together are larger than 4 KB, even when each path is small", () => {
    // Ten paths of 500 bytes each: 5,000 bytes together.
    const checked = checkPluginMark({
      paths: Array.from({ length: 10 }, () => "L1 1 ".repeat(100)),
    });

    expect(checked).toEqual({
      markError: "The plugin's mark was left out because its paths together are larger than 4 KB.",
    });
  });

  it("keeps a mark whose paths together hold exactly 4 KB", () => {
    const mark = {
      paths: ["M0 0".padEnd(MAX_ICON_BYTES / 2, " "), "L1 1".padEnd(MAX_ICON_BYTES / 2, " ")],
    };

    expect(checkPluginMark(mark)).toEqual({ mark });
  });

  it("keeps a mark with as many paths as allowed, and drops one with more", () => {
    const allowed = { paths: Array.from({ length: MAX_ICON_PATHS }, () => "M0 0h1") };

    expect(checkPluginMark(allowed)).toEqual({ mark: allowed });
    expect(checkPluginMark({ paths: [...allowed.paths, "M0 0h1"] })).toEqual({
      markError:
        "The plugin's mark was left out because it has 17 paths, and an icon may have at most 16.",
    });
  });

  it("drops a mark with no paths", () => {
    expect(checkPluginMark({ paths: [] })).toEqual({
      markError: "The plugin's mark was left out because it has no paths.",
    });
  });

  it("keeps a mark with a hue as it is", () => {
    const mark = { paths: ["M0 0h1"], hue: 210 };

    expect(checkPluginMark(mark)).toEqual({ mark });
  });

  it("turns the CSS colour names of a mark into hex codes", () => {
    expect(checkPluginMark({ paths: ["M0 0h1"], color: "purple" })).toEqual({
      mark: { paths: ["M0 0h1"], color: "#800080" },
    });
    expect(
      checkPluginMark({ paths: ["M0 0h1"], color: { light: "#ABC", dark: "salmon" } }),
    ).toEqual({ mark: { paths: ["M0 0h1"], color: { light: "#aabbcc", dark: "#fa8072" } } });
  });

  it("drops a mark whose colour is no CSS colour", () => {
    expect(
      checkPluginMark({ paths: ["M0 0h1"], color: { light: "#fff", dark: "purpel" } }),
    ).toEqual({
      markError:
        'The plugin\'s mark was left out because its colour { light: "#fff", dark: "purpel" } is not a CSS colour. Write a hex code such as "#8250df" or a CSS colour name such as "purple".',
    });
  });
});
