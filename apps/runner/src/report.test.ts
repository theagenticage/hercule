/** Tests that text from outside the runner has its control and format characters escaped. */
import { describe, expect, it } from "vitest";
import { escapeControlCharacters } from "./report";

describe("escapeControlCharacters", () => {
  it("writes control, separator and format characters as escapes, and keeps other text", () => {
    // Line feed, a right-to-left override, and a line separator.
    expect(escapeControlCharacters("a\nb\u202ec\u2028d é😀")).toBe(
      "a\\u{a}b\\u{202e}c\\u{2028}d é😀",
    );
  });
});
