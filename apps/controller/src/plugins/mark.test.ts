import { describe, expect, it } from "vitest";
import { checkPluginMark, MAX_MARK_BYTES, MAX_MARK_PATHS } from "./mark";

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
      paths: ["M0 0".padEnd(MAX_MARK_BYTES / 2, " "), "L1 1".padEnd(MAX_MARK_BYTES / 2, " ")],
    };

    expect(checkPluginMark(mark)).toEqual({ mark });
  });

  it("keeps a mark with as many paths as allowed, and drops one with more", () => {
    const allowed = { paths: Array.from({ length: MAX_MARK_PATHS }, () => "M0 0h1") };

    expect(checkPluginMark(allowed)).toEqual({ mark: allowed });
    expect(checkPluginMark({ paths: [...allowed.paths, "M0 0h1"] })).toEqual({
      markError:
        "The plugin's mark was left out because it has 17 paths, and a mark may have at most 16.",
    });
  });

  it("drops a mark with no paths", () => {
    expect(checkPluginMark({ paths: [] })).toEqual({
      markError: "The plugin's mark was left out because it has no paths.",
    });
  });
});
