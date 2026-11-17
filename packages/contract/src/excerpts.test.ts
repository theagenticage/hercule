/** Tests the helpers that join names into an English list. */
import { describe, expect, it } from "vitest";
import { joinAllNames, joinNames } from "./excerpts";

describe("joinAllNames", () => {
  it("joins one, two and many names as an English list, without shortening", () => {
    expect(joinAllNames([])).toBe("");
    expect(joinAllNames(["a"])).toBe("a");
    expect(joinAllNames(["a", "b"])).toBe("a and b");
    expect(joinAllNames(["a", "b", "c", "d", "e", "f", "g"])).toBe("a, b, c, d, e, f and g");
  });
});

describe("joinNames", () => {
  it("joins up to five names like joinAllNames", () => {
    expect(joinNames(["a", "b", "c", "d", "e"])).toBe("a, b, c, d and e");
  });

  it("lists the first five names and counts the rest", () => {
    expect(joinNames(["a", "b", "c", "d", "e", "f", "g", "h"])).toBe("a, b, c, d, e and 3 more");
  });
});
