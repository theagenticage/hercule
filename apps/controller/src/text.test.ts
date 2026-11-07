/** Tests cutting a text to a length and taking the end of a text. */
import { describe, expect, it } from "vitest";
import { cutText, cutTextAtWord, takeTail } from "./text";

describe("cutTextAtWord", () => {
  it.each([
    ["a short text", "Three designs", 20, "Three designs"],
    ["a text exactly at the limit", "Three designs", 13, "Three designs"],
    ["a break early in the text", "A reconciliationservice rewrite", 20, "A…"],
    ["a break in the second half", "Three designs and depots", 20, "Three designs and…"],
    ["a space right after the kept part", "Three designs depots", 14, "Three designs…"],
    ["a line break", "Three\ndesigns and depots", 15, "Three\ndesigns…"],
    ["one word longer than the limit", "reconciliationservice", 10, "reconcili…"],
    ["a surrogate pair at the cut", "ab😀😀😀", 4, "ab…"],
  ])("cuts %s", (_name, text, limit, expected) => {
    const cut = cutTextAtWord(text, limit);

    expect(cut).toBe(expected);
    expect(cut.length).toBeLessThanOrEqual(limit);
  });
});

describe("cutText", () => {
  it("returns a text that fits unchanged", () => {
    expect(cutText("a\n\nb", 10)).toBe("a\n\nb");
    expect(cutText("x".repeat(10), 10)).toBe("x".repeat(10));
  });

  it("cuts at the last paragraph break within the limit, before a line break or a word", () => {
    expect(cutText("first line\nsecond line\n\nthird paragraph runs on", 40)).toBe(
      "first line\nsecond line…",
    );
  });

  it("cuts at the last line break when there is no paragraph break", () => {
    expect(cutText("- one\n- two\n- three\n- four five six", 25)).toBe("- one\n- two\n- three…");
  });

  it("cuts at the last word when there is no break", () => {
    expect(cutText("alpha beta gamma delta", 14)).toBe("alpha beta…");
  });

  it("cuts just short of the limit, so the ellipsis fits, when there is nothing to break on", () => {
    const cut = cutText("x".repeat(30), 10);

    expect(cut).toBe("x".repeat(9) + "…");
    expect(cut).toHaveLength(10);
  });

  it.each([
    ["a text with words", "word ".repeat(100)],
    ["a text with lines", "line\n".repeat(100)],
    ["a text with nothing to break on", "x".repeat(500)],
    ["a text of emoji", "😀".repeat(200)],
  ])("never returns more than the limit, for %s", (_, text) => {
    for (const limit of [1, 2, 3, 10, 49, 50, 51, 80]) {
      expect(cutText(text, limit).length).toBeLessThanOrEqual(limit);
    }
  });

  it("accepts a break exactly at half the limit", () => {
    expect(cutText("abcde\nfghijklmnop", 10)).toBe("abcde…");
  });

  it("ignores a paragraph break in the first half and falls back to a later line break", () => {
    expect(cutText("ab\n\ncdef\nghi jklmnop", 12)).toBe("ab\n\ncdef…");
  });

  it("ignores breaks in the first half and cuts at a space in the second half", () => {
    expect(cutText("ab\n\ncd\nefghi jklm nopq", 16)).toBe("ab\n\ncd\nefghi…");
  });

  it("cuts at the limit when every break is in the first half", () => {
    expect(cutText("ab\n\nc defghijklmnopqrstuvwxyz", 12)).toBe("ab\n\nc defgh…");
  });

  it("does not split a surrogate pair", () => {
    const cut = cutText("a" + "😀".repeat(10), 4);

    expect(cut).toBe("a😀…");
  });

  it("drops a high surrogate that the cut would leave at its end", () => {
    expect(cutText("a" + "😀".repeat(10), 3)).toBe("a…");
  });
  it("ignores a break at the very start", () => {
    expect(cutText("\nabcdefghijklmnop", 8)).toBe("\nabcdef…");
  });
});

describe("takeTail", () => {
  it("returns a text that fits unchanged", () => {
    expect(takeTail("abc", 3)).toBe("abc");
  });

  it("keeps the last characters", () => {
    expect(takeTail("abcdef", 2)).toBe("ef");
  });

  it("drops the second half of a surrogate pair that the cut would start in", () => {
    expect(takeTail("a😀b", 2)).toBe("b");
  });

  it("keeps a whole pair when the cut falls before it", () => {
    expect(takeTail("a😀b", 3)).toBe("😀b");
  });
});
