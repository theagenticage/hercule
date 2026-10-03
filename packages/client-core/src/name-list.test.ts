import { describe, expect, it } from "vitest";
import { formatNameList } from "./name-list";

describe("formatNameList", () => {
  it("lists one, two and three names with no comma before the conjunction", () => {
    expect(formatNameList(["Claude Code"], "and")).toBe("Claude Code");
    expect(formatNameList(["Claude Code", "Codex"], "or")).toBe("Claude Code or Codex");
    expect(formatNameList(["DELETE", "PATCH", "PUT"], "and")).toBe("DELETE, PATCH and PUT");
  });

  it("returns an empty string for no names", () => {
    expect(formatNameList([], "and")).toBe("");
  });
});
