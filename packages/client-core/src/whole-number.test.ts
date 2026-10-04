import { assert, describe, it } from "vitest";
import { parseWholeNumber } from "./whole-number";

describe("parseWholeNumber", () => {
  it("returns the number for digits, ignoring spaces around them", () => {
    assert.strictEqual(parseWholeNumber("7"), 7);
    assert.strictEqual(parseWholeNumber(" 300 "), 300);
    assert.strictEqual(parseWholeNumber("0"), 0);
  });

  it("returns undefined for text that is not only digits", () => {
    for (const text of ["", "  ", "abc", "1.5", "-5", "+5", "1e3", "0x10", "7 days"]) {
      assert.isUndefined(parseWholeNumber(text), text);
    }
  });
});
