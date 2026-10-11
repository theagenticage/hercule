import { describe, expect, it } from "vitest";
import { cutText } from "./text";

describe("cutText", () => {
  it("returns text that fits as it is", () => {
    expect(cutText("hello", 5)).toBe("hello");
  });

  it("cuts longer text and ends it with an ellipsis", () => {
    expect(cutText("hello world", 6)).toBe("hello…");
  });

  it("never keeps half of a character that takes two UTF-16 units", () => {
    // "ab🎉cd" is six units long: the emoji is the third and fourth.
    expect(cutText("ab🎉cd", 4)).toBe("ab…");
    expect(cutText("ab🎉cd", 5)).toBe("ab🎉…");
  });
});
