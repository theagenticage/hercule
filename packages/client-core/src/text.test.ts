import { describe, expect, it } from "vitest";
import { cutWithEllipsis, dropClosingFullStops, endSentence } from "./text";

describe("cutWithEllipsis", () => {
  it("returns text that fits as it is", () => {
    expect(cutWithEllipsis("Review PR", 9)).toBe("Review PR");
  });

  it("cuts longer text so that the ellipsis counts in the length", () => {
    expect(cutWithEllipsis("Review the PR now", 10)).toBe("Review th…");
  });

  it("leaves no space before the ellipsis", () => {
    expect(cutWithEllipsis("Serve smaller things now", 15)).toBe("Serve smaller…");
  });

  it("does not split a character made of two code units", () => {
    expect(cutWithEllipsis("ab😀cd", 4)).toBe("ab…");
  });
});

describe("dropClosingFullStops", () => {
  it.each([
    ["The branch changed.", "The branch changed"],
    ["Waiting...", "Waiting"],
    ["No full stop", "No full stop"],
    ["Version 1.2 is out", "Version 1.2 is out"],
  ])("turns %j into %j", (text, expected) => {
    expect(dropClosingFullStops(text)).toBe(expected);
  });
});

describe("endSentence", () => {
  it.each([
    ["Review PR is already working on this", "Review PR is already working on this."],
    ["Try again in a moment.", "Try again in a moment."],
    ["Is it done?", "Is it done?"],
  ])("%s", (text, sentence) => {
    expect(endSentence(text)).toBe(sentence);
  });
});
