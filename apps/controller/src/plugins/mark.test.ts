import { describe, expect, it } from "vitest";
import { checkPluginMark, MAX_MARK_PATH_BYTES } from "./mark";

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

  it("drops a mark with a path larger than 4 KB", () => {
    const checked = checkPluginMark({ paths: ["M0 0", "L1 1 ".repeat(MAX_MARK_PATH_BYTES / 4)] });

    expect(checked).toEqual({
      markError: "The plugin's mark was left out because one of its paths is larger than 4 KB.",
    });
  });

  it("drops a mark with no paths", () => {
    expect(checkPluginMark({ paths: [] })).toEqual({
      markError: "The plugin's mark was left out because it has no paths.",
    });
  });
});
