/** Tests `setDisallowedTool(tools, family, disallowed)`, which adds or removes one tool family. */
import { describe, expect, it } from "vitest";
import { setDisallowedTool } from "./disallowed-tools";

describe("setDisallowedTool", () => {
  it("adds a family at the end", () => {
    expect(setDisallowedTool(["shell"], "edit", true)).toEqual(["shell", "edit"]);
  });

  it("removes a family and keeps the others in order", () => {
    expect(setDisallowedTool(["shell", "edit", "write"], "edit", false)).toEqual([
      "shell",
      "write",
    ]);
  });

  it("returns the list itself when it already says so", () => {
    const tools = ["shell"] as const;
    expect(setDisallowedTool(tools, "shell", true)).toBe(tools);
    expect(setDisallowedTool(tools, "edit", false)).toBe(tools);
  });
});
